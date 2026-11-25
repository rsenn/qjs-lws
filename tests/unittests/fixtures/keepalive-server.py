# HTTP/1.1 keep-alive server for test-fetch-idle-gap.js: answers every
# request with the port the client connects from, so a test can tell whether
# two requests shared a connection.
import signal, socketserver, sys

signal.alarm(60)  # a test that exits early cannot leave the server behind

class H(socketserver.StreamRequestHandler):
    def handle(self):
        while True:
            if not self.rfile.readline(): return
            length = 0
            while True:
                h = self.rfile.readline()
                if h in (b'\r\n', b'\n', b''): break
                if h.lower().startswith(b'content-length:'): length = int(h.split(b':')[1])
            self.rfile.read(length)
            body = str(self.client_address[1]).encode()
            self.wfile.write(b'HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n' % len(body) + body)

class S(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

S(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
