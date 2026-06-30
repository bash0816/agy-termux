#define _GNU_SOURCE
#include <signal.h>
#include <ucontext.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>

#ifndef __NR_faccessat2
#define __NR_faccessat2 439
#endif

static struct sigaction old_sigsys_action;

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

__attribute__((constructor))
static void install_sigsys_shim(void) {
    struct sigaction sa;
    sa.sa_sigaction = sigsys_handler;
    sa.sa_flags = SA_SIGINFO | SA_RESTART;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGSYS, &sa, &old_sigsys_action);
}
