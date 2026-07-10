import { ServerRequest as Request, ServerResponse as Response, App, Router } from '../lib/lws/app.js';

const app = new App();

//app.use(json());
//app.use(cors({ origin: '*' }));

app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));

app.get('/echo', (req, res) => res.json({ ...req.headers }));

app.listen({ port: 8080 });
