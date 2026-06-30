#define _GNU_SOURCE
#include <signal.h>
#include <ucontext.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <pthread.h>
#include <time.h>

#ifndef __NR_faccessat2
#define __NR_faccessat2 439
#endif

static struct sigaction old_sigsys_action;
static struct sigaction our_action;

static void sigsys_handler(int sig, siginfo_t *info, void *ucontext_void) {
    ucontext_t *uc = (ucontext_t *)ucontext_void;
    long syscall_nr = uc->uc_mcontext.regs[8];

    if (syscall_nr == __NR_faccessat2) {
        uc->uc_mcontext.regs[0] = (unsigned long)(-ENOSYS);
        uc->uc_mcontext.pc += 4;
        return;
    }

    if (old_sigsys_action.sa_flags & SA_SIGINFO) {
        if (old_sigsys_action.sa_sigaction) {
            old_sigsys_action.sa_sigaction(sig, info, ucontext_void);
            return;
        }
    } else if (old_sigsys_action.sa_handler == SIG_DFL || old_sigsys_action.sa_handler == NULL) {
        signal(SIGSYS, SIG_DFL);
        raise(SIGSYS);
        return;
    }
    _exit(159);
}

/*
 * The Go runtime installs its own SIGSYS handler during runtime/thread
 * initialization (observed: it overwrites ours sometime after process
 * startup, converting later faccessat2 SIGSYS faults into a fatal Go
 * panic instead of reaching this handler). Re-arming our handler from a
 * background thread wins back the signal disposition each time Go's
 * runtime steals it.
 */
static void *rearm_loop(void *unused) {
    (void)unused;
    struct timespec ts = { .tv_sec = 0, .tv_nsec = 20 * 1000 * 1000 }; /* 20ms */
    for (;;) {
        sigaction(SIGSYS, &our_action, NULL);
        nanosleep(&ts, NULL);
    }
    return NULL;
}

__attribute__((constructor))
static void install_sigsys_shim(void) {
    our_action.sa_sigaction = sigsys_handler;
    our_action.sa_flags = SA_SIGINFO | SA_RESTART;
    sigemptyset(&our_action.sa_mask);
    sigaction(SIGSYS, &our_action, &old_sigsys_action);

    pthread_t tid;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    pthread_create(&tid, &attr, rearm_loop, NULL);
    pthread_attr_destroy(&attr);

    /*
     * The dynamic linker has already preloaded this .so by the time this
     * constructor runs, so it is now safe to drop LD_PRELOAD from the
     * process's own environment. Without this, child processes spawned
     * by agy (e.g. its sandboxed shell tool, which execs the Android
     * bionic-linked bash, not glibc) inherit LD_PRELOAD and fail to
     * start because they cannot load this glibc-linked shared object.
     */
    unsetenv("LD_PRELOAD");
}
