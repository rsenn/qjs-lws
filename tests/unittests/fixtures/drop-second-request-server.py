# HTTP/1.1 keep-alive server for test-fetch-keepalive-race.js: the first
# request on a connection is answered, the second one is closed on without
# being read, so the connection is reset (a server that closes an idle
# connection just as the next request arrives on it).
import signal, socket, socketserver, sys

signal.alarm(60)  # a test that exits early cannot leave the server behind

class H(socketserver.StreamRequestHandler):
    def handle(self):
        n = 0
        while True:
            if n == 1:
                self.connection.recv(1, socket.MSG_PEEK)  # wait for the request
                return  # close with it unread: the peer gets a reset
            line = self.rfile.readline()
            if not line: return
            length = 0
            while True:
                h = self.rfile.readline()
                if h in (b'\r\n', b'\n', b''): break
                if h.lower().startswith(b'content-length:'): length = int(h.split(b':')[1])
            self.rfile.read(length)
            n += 1
            self.wfile.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')

class S(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

S(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
