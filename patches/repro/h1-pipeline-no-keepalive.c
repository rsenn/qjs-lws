/*
 * Reproduction: h1 client requests queued behind a pipelined request whose
 * server does not keep the connection alive are never sent.
 *
 * Two GETs to the same endpoint with LCCSCF_PIPELINE are made in the same
 * tick: the second one is queued behind the first on its connection.  The
 * server (a child process, plain sockets) answers each connection once
 * HTTP/1.0 style, a body without a length that ends with the connection,
 * and hangs up shortly after.  The client learns from the first
 * response that the connection is not going to be kept alive, and the
 * queued request has to be restarted on a connection of its own.  Without
 * the fix it is reset to unconnected and nothing ever connects it: no
 * error, no callback, just silence.
 *
 *   cc -o h1-pipeline-no-keepalive h1-pipeline-no-keepalive.c \
 *      -I<lws>/include -I<lws-build> <lws-build>/lib/libwebsockets.a \
 *      -lz -lcap -lpthread
 *   ./h1-pipeline-no-keepalive
 *
 * Exits 0 if both requests completed, 1 if not (prints how many did).
 */
#include <libwebsockets.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define PORT 17894
#define REQUESTS 2

static int completed, failed;

static int
callback(struct lws *wsi, enum lws_callback_reasons reason, void *user,
	 void *in, size_t len)
{
	char buffer[LWS_PRE + 1024], *px = buffer + LWS_PRE;
	int lenx = sizeof(buffer) - LWS_PRE;

	switch (reason) {
	case LWS_CALLBACK_RECEIVE_CLIENT_HTTP:
		/* the response body has to be drained, or rx never resumes */
		if (lws_http_client_read(wsi, &px, &lenx) < 0)
			return -1;
		return 0;

	case LWS_CALLBACK_COMPLETED_CLIENT_HTTP:
		completed++;
		break;

	case LWS_CALLBACK_CLIENT_CONNECTION_ERROR:
		failed++;
		break;

	default:
		break;
	}

	return lws_callback_http_dummy(wsi, reason, user, in, len);
}

static const struct lws_protocols protocols[] = {
	{ "http", callback, 0, 0, 0, NULL, 0 },
	LWS_PROTOCOL_LIST_TERM
};

/* the child: one response and a hang-up for each connection */
static int
server(int ls)
{
	/* HTTP/1.0 style: the body ends where the connection does */
	static const char rsp[] = "HTTP/1.0 200 OK\r\n\r\nok";
	char req[2048];
	int fd, i;

	for (i = 0; i < REQUESTS; i++) {
		size_t n = 0;

		fd = accept(ls, NULL, NULL);
		if (fd < 0)
			return 2;
		while (n < sizeof(req) - 1) {
			ssize_t r = read(fd, req + n, sizeof(req) - 1 - n);

			if (r <= 0)
				break;
			n += (size_t)r;
			req[n] = 0;
			if (strstr(req, "\r\n\r\n"))
				break;
		}
		if (write(fd, rsp, sizeof(rsp) - 1) < 0)
			return 2;
		/*
		 * Not hanging up at once: the client has to see that this
		 * connection is not kept alive while it is still open
		 */
		usleep(200000);
		close(fd);
	}

	return 0;
}

int
main(void)
{
	struct sockaddr_in sa = { .sin_family = AF_INET,
				  .sin_port = htons(PORT) };
	struct lws_context_creation_info info;
	struct lws_client_connect_info cc;
	struct lws_context *cx;
	time_t t0 = time(NULL);
	int ls, one = 1, i, st;
	pid_t pid;

	inet_pton(AF_INET, "127.0.0.1", &sa.sin_addr);
	ls = socket(AF_INET, SOCK_STREAM, 0);
	setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
	if (bind(ls, (struct sockaddr *)&sa, sizeof(sa)) || listen(ls, 8))
		return 2;

	pid = fork();
	if (!pid)
		_exit(server(ls));
	close(ls);

	memset(&info, 0, sizeof(info));
	info.port = CONTEXT_PORT_NO_LISTEN;
	info.protocols = protocols;
	cx = lws_create_context(&info);
	if (!cx)
		return 2;

	for (i = 0; i < REQUESTS; i++) {
		memset(&cc, 0, sizeof(cc));
		cc.context = cx;
		cc.address = "127.0.0.1";
		cc.port = PORT;
		cc.path = "/";
		cc.host = cc.origin = "127.0.0.1";
		cc.method = "GET";
		cc.protocol = "http";
		cc.local_protocol_name = "http";
		cc.ssl_connection = LCCSCF_PIPELINE;
		if (!lws_client_connect_via_info(&cc))
			return 2;
	}

	while (completed + failed < REQUESTS && time(NULL) - t0 < 5)
		lws_service(cx, 20);

	lws_context_destroy(cx);
	kill(pid, SIGKILL);
	waitpid(pid, &st, 0);

	printf("%d of %d requests completed, %d failed\n", completed, REQUESTS,
	       failed);

	return completed == REQUESTS ? 0 : 1;
}
