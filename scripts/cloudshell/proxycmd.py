#!/usr/bin/env python3
"""
proxycmd.py — ssh ProxyCommand shim.

Connects stdin/stdout to the local port served by `cloudshell.py`'s relay
bridge. Use raw os.read/os.write, never sys.stdin.buffer: buffered stdin can
deadlock at interpreter shutdown while the daemon thread is still alive.

    ssh -o "ProxyCommand=python3 -I proxycmd.py 2238" user@host
"""

import os
import socket
import sys
import threading


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 2222
    try:
        sock = socket.create_connection(("127.0.0.1", port), timeout=60)
    except OSError as e:
        print(f"proxycmd: cannot reach bridge on 127.0.0.1:{port}: {e}",
              file=sys.stderr)
        return 1

    def stdin_to_sock():
        while True:
            try:
                data = os.read(0, 65536)
            except OSError:
                data = b""
            if not data:
                try:
                    sock.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
                return
            try:
                sock.sendall(data)
            except OSError:
                return

    threading.Thread(target=stdin_to_sock, daemon=True).start()

    while True:
        try:
            chunk = sock.recv(65536)
        except OSError:
            break
        if not chunk:
            break
        try:
            os.write(1, chunk)
        except OSError:
            break

    os._exit(0)


if __name__ == "__main__":
    sys.exit(main())
