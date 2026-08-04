#!/usr/bin/env python3
"""本地静态服务（禁缓存）：python3 serve.py [port]"""
import http.server, sys
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()
    def log_message(self, *a): pass
if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
    http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
