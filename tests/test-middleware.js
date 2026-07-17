import { compilePath, ServerRequest, ServerResponse, App, Router } from '../lib/lws/app.js';
import { json, urlencoded, raw, text, cookies, cors, logger, secure } from '../lib/lws/middleware.js';
import { session } from '../lib/lws/session.js';

const app = new App();

app.use(session());

//app.use(cors({ origin: '*' }));

app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));

app.get('/echo', (req, res) => res.json({ ...req.headers }));

app.listen({ port: 8886 });
