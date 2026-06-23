#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/syscall.h>

int main(int argc, char *argv[], char *envp[]) {
    if (argc < 3) { fprintf(stderr, "usage: memexec <size> <arg0> [args...]\n"); return 1; }
    size_t size = (size_t)strtoull(argv[1], NULL, 10);
    if (size == 0 || size > 512ULL*1024*1024) { fprintf(stderr, "memexec: invalid size\n"); return 1; }
    int fd = (int)syscall(SYS_memfd_create, "agy", 0);
    if (fd < 0) { perror("memfd_create"); return 1; }
    if (ftruncate(fd, (off_t)size) < 0) { perror("ftruncate"); return 1; }
    char *buf = mmap(NULL, size, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);
    if (buf == MAP_FAILED) { perror("mmap"); return 1; }
    size_t total = 0;
    while (total < size) {
        ssize_t n = read(STDIN_FILENO, buf+total, size-total);
        if (n <= 0) break;
        total += (size_t)n;
    }
    munmap(buf, size);
    char fdpath[64];
    snprintf(fdpath, sizeof(fdpath), "/proc/self/fd/%d", fd);
    execve(fdpath, argv+2, envp);
    perror("execve");
    return 1;
}
