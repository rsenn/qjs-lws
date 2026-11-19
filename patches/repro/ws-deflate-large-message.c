/*
 * Reproduction: a permessage-deflate message that inflates to more than one
 * rx buffer loses output when received (lws_parse_ws(), server side).
 *
 * The server is an lws vhost on a loopback port with permessage-deflate.
 * The client is a child process doing a plain-socket handshake and then
 * sending one compressed binary message in a single write(), the way any
 * peer that is not lws does (browsers, python websockets, ws, Bun): the
 * whole frame is in the server's first read, so lws_parse_ws() takes its
 * payload in bulk.  The server counts and checks what it gets in RECEIVE.
 *
 *   cc -o ws-deflate-large-message ws-deflate-large-message.c \
 *      -I<lws>/include -I<lws-build> <lws-build>/lib/libwebsockets.a \
 *      -lz -lcap -lpthread
 *   ./ws-deflate-large-message [message-size]
 *
 * Exits 0 if the whole message arrived intact, 1 if not (prints how much
 * of it did).  Without the fix a 70000 byte message arrives short.
 */
#include <libwebsockets.h>
#include <zlib.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define PORT 17893

static size_t msg_size = 70000, got, bad;
static int done;

static unsigned char
pattern(size_t i)
{
	/*
	 * Hardly compressible: the compressed message is nearly as large
	 * as the message
	 */
	unsigned int x = (unsigned int)i * 2654435761u;

	x ^= x >> 15;
	x *= 2246822519u;
	x ^= x >> 13;

	return (unsigned char)(x >> 8);
}

static int
callback(struct lws *wsi, enum lws_callback_reasons reason, void *user,
	 void *in, size_t len)
{
	size_t i;

	switch (reason) {
	case LWS_CALLBACK_RECEIVE:
		for (i = 0; i < len; i++)
			if (((unsigned char *)in)[i] != pattern(got + i))
				bad++;
		got += len;
		if (lws_is_final_fragment(wsi))
			done = 1;
		break;

	case LWS_CALLBACK_CLOSED:
		done = 1;
		break;

	default:
		break;
	}

	return 0;
}

static const struct lws_protocols protocols[] = {
	{ "repro", callback, 0, 0, 0, NULL, 0 },
	LWS_PROTOCOL_LIST_TERM
};

static const struct lws_extension extensions[] = {
	{ "permessage-deflate", lws_extension_callback_pm_deflate,
	  "permessage-deflate" },
	{ NULL, NULL, NULL }
};

static void
write_all(int fd, const void *p, size_t n)
{
	const char *c = p;
	ssize_t r;

	while (n && (r = write(fd, c, n)) > 0) {
		c += r;
		n -= (size_t)r;
	}
}

/* the child: handshake, then the message as one frame in one write */
static int
client(void)
{
	static const char hs[] =
		"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n"
		"Connection: Upgrade\r\n"
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: repro\r\n"
		"Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n";
	struct sockaddr_in sa = { .sin_family = AF_INET,
				  .sin_port = htons(PORT) };
	unsigned char *in, *out, *frame, resp[1024];
	size_t i, clen;
	z_stream z;
	int fd;

	inet_pton(AF_INET, "127.0.0.1", &sa.sin_addr);
	fd = socket(AF_INET, SOCK_STREAM, 0);
	if (connect(fd, (struct sockaddr *)&sa, sizeof(sa)))
		return 2;

	write_all(fd, hs, sizeof(hs) - 1);
	if (read(fd, resp, sizeof(resp)) <= 0)
		return 2;

	in = malloc(msg_size);
	out = malloc(msg_size + msg_size / 100 + 1024);
	frame = malloc(msg_size + msg_size / 100 + 1024 + 14);
	for (i = 0; i < msg_size; i++)
		in[i] = pattern(i);

	/* raw deflate, sync flush, the 00 00 ff ff tail is left off */
	memset(&z, 0, sizeof(z));
	deflateInit2(&z, Z_DEFAULT_COMPRESSION, Z_DEFLATED, -15, 8,
		     Z_DEFAULT_STRATEGY);
	z.next_in = in;
	z.avail_in = (uInt)msg_size;
	z.next_out = out;
	z.avail_out = (uInt)(msg_size + msg_size / 100 + 1024);
	deflate(&z, Z_SYNC_FLUSH);
	clen = z.total_out - 4;

	/* FIN, RSV1 (compressed), binary; masked with a zero key */
	frame[0] = 0xc2;
	frame[1] = 0x80 | 127;
	for (i = 0; i < 8; i++)
		frame[2 + i] = (unsigned char)((uint64_t)clen >> (56 - 8 * i));
	memset(frame + 10, 0, 4);
	memcpy(frame + 14, out, clen);
	write_all(fd, frame, 14 + clen);

	/* stay until the server is done with us */
	while (read(fd, resp, sizeof(resp)) > 0)
		;

	return 0;
}

int
main(int argc, char **argv)
{
	struct lws_context_creation_info info;
	struct lws_context *cx;
	int n = 0, st;
	pid_t pid;

	if (argc > 1)
		msg_size = (size_t)atol(argv[1]);

	memset(&info, 0, sizeof(info));
	info.port = PORT;
	info.iface = "127.0.0.1";
	info.protocols = protocols;
	info.extensions = extensions;

	cx = lws_create_context(&info);
	if (!cx)
		return 2;

	pid = fork();
	if (!pid)
		_exit(client());

	while (!done && n++ < 500)
		lws_service(cx, 20);

	lws_context_destroy(cx);
	waitpid(pid, &st, 0);

	printf("sent %d bytes, received %d, %d wrong\n", (int)msg_size, (int)got, (int)bad);

	return got == msg_size && !bad ? 0 : 1;
}
