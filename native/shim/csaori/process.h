/* process.h の代わり (CSaori の SAORI が使うものだけ)。スレッドは作れないので、その場で最後まで走らせる */
#ifndef ENGAWA_PROCESS_H
#define ENGAWA_PROCESS_H

#include <stdint.h>

static inline uintptr_t _beginthread(void (*start)(void *), unsigned stack, void *arg) {
  (void)stack;
  start(arg);
  return 1;
}

#endif
