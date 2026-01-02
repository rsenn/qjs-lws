import { WebSocket } from '../lib/websocket.js';
import { test } from './lib/testharnessreport.js';

test(() => {
  const ws = new WebSocket('ws://localhost/ws', []);
}, 'Create WebSocket');