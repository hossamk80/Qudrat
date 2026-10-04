"""Optional local-only launcher. Requires Python 3; no third-party packages."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from functools import partial
import threading
import webbrowser

if __name__ == '__main__':
    root = Path(__file__).resolve().parent
    handler = partial(SimpleHTTPRequestHandler, directory=str(root))
    try:
        server = ThreadingHTTPServer(('127.0.0.1', 8765), handler)
    except OSError as error:
        print('Could not start on port 8765. Close an earlier launcher and try again.')
        print(error)
        raise SystemExit(1)
    print('Qudrat is running at http://127.0.0.1:8765/index.html')
    print('Press Ctrl+C or close this window to stop.')
    threading.Timer(0.5, lambda: webbrowser.open('http://127.0.0.1:8765/index.html')).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
