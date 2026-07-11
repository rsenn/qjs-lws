import { Body } from '../../lib/lws/body.js';

let b = new Body('blah');

console.log('b', b);
console.log('b.body', await b.body);
console.log('b.text()', await b.text());
