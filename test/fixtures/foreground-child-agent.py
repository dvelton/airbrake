#!/usr/bin/env python3

import os
import signal
import sys
import time


output = sys.argv[1]
child = os.fork()

if child == 0:
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    os.setpgid(0, 0)
    os.tcsetpgrp(sys.stdin.fileno(), os.getpgrp())
    with open(output, "ab", buffering=0) as output_file:
        output_file.write(b"started\n")
        while True:
            chunk = os.read(sys.stdin.fileno(), 4096)
            if not chunk:
                break
            output_file.write(chunk)
    raise SystemExit(0)

while True:
    time.sleep(1)
