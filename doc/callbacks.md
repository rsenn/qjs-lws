# Callback reasons

Every `LWS_CALLBACK_*` reason is exposed as an integer constant on
the `lws` module and as a camelCased name (via `getCallbackName`).
Use the named handlers on your protocol descriptor for clarity:

```js
{
  name: 'http',
  onHttp(wsi, uri) { … },
  onClosedHttp(wsi) { … },
}
```

The list below mirrors `lws_callback_names[]` in `lws.c` and
documents the JS arguments after `wsi`.

## WebSocket server

| Constant | Handler | Arguments |
|----------|---------|-----------|
| `LWS_CALLBACK_ESTABLISHED`            | `onEstablished`           | `(sslPtrString, len)` |
| `LWS_CALLBACK_RECEIVE`                | `onReceive`               | `(data, len [, frame])` |
| `LWS_CALLBACK_RECEIVE_PONG`           | `onReceivePong`           | `(data, len)` |
| `LWS_CALLBACK_SERVER_WRITEABLE`       | `onServerWriteable`       | `()` |
| `LWS_CALLBACK_CLOSED`                 | `onClosed`                | `()` |
| `LWS_CALLBACK_WS_PEER_INITIATED_CLOSE`| `onWsPeerInitiatedClose`  | `(code, reasonString)` |
| `LWS_CALLBACK_WS_SERVER_BIND_PROTOCOL`| `onWsServerBindProtocol`  | `()` |
| `LWS_CALLBACK_WS_SERVER_DROP_PROTOCOL`| `onWsServerDropProtocol`  | `()` |
| `LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION` | `onFilterProtocolConnection` | `(data, len)` |
| `LWS_CALLBACK_CONFIRM_EXTENSION_OKAY` | `onConfirmExtensionOkay`  | `(name)` |
| `LWS_CALLBACK_WS_EXT_DEFAULTS`        | `onWsExtDefaults`         | `()` |

## WebSocket client

| Constant | Handler | Arguments |
|----------|---------|-----------|
| `LWS_CALLBACK_CLIENT_ESTABLISHED`        | `onClientEstablished`        | `()` |
| `LWS_CALLBACK_CLIENT_CONNECTION_ERROR`   | `onClientConnectionError`    | `(message, errno)` |
| `LWS_CALLBACK_CLIENT_FILTER_PRE_ESTABLISH`| `onClientFilterPreEstablish`| `(data, len)` |
| `LWS_CALLBACK_CLIENT_RECEIVE`            | `onClientReceive`            | `(data, len [, frame])` |
| `LWS_CALLBACK_CLIENT_RECEIVE_PONG`       | `onClientReceivePong`        | `(data, len)` |
| `LWS_CALLBACK_CLIENT_WRITEABLE`          | `onClientWriteable`          | `()` |
| `LWS_CALLBACK_CLIENT_CLOSED`             | `onClientClosed`             | `()` |
| `LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER` | `onClientAppendHandshakeHeader` | `(buf, lenArray)` |
| `LWS_CALLBACK_CLIENT_CONFIRM_EXTENSION_SUPPORTED` | `onClientConfirmExtensionSupported` | `(name)` |
| `LWS_CALLBACK_WS_CLIENT_BIND_PROTOCOL`   | `onWsClientBindProtocol`     | `()` |
| `LWS_CALLBACK_WS_CLIENT_DROP_PROTOCOL`   | `onWsClientDropProtocol`     | `()` |

The `frame` argument to `onReceive`/`onClientReceive` is only
present for multi-fragment messages. It is a `{ multifragment: true,
first, final }` descriptor — use it to reassemble big frames.

## HTTP server

| Constant | Handler | Arguments |
|----------|---------|-----------|
| `LWS_CALLBACK_HTTP`                       | `onHttp`                  | `(uri)` |
| `LWS_CALLBACK_HTTP_BODY`                  | `onHttpBody`              | `(data, len)` |
| `LWS_CALLBACK_HTTP_BODY_COMPLETION`       | `onHttpBodyCompletion`    | `()` |
| `LWS_CALLBACK_HTTP_FILE_COMPLETION`       | `onHttpFileCompletion`    | `()` |
| `LWS_CALLBACK_HTTP_WRITEABLE`             | `onHttpWriteable`         | `()` |
| `LWS_CALLBACK_HTTP_BIND_PROTOCOL`         | `onHttpBindProtocol`      | `()` |
| `LWS_CALLBACK_HTTP_DROP_PROTOCOL`         | `onHttpDropProtocol`      | `()` |
| `LWS_CALLBACK_HTTP_CONFIRM_UPGRADE`       | `onHttpConfirmUpgrade`    | `(typeString)` |
| `LWS_CALLBACK_HTTP_PMO`                   | `onHttpPmo`               | `(data, len)` |
| `LWS_CALLBACK_FILTER_NETWORK_CONNECTION`  | `onFilterNetworkConnection` | `(sslPtr)` |
| `LWS_CALLBACK_FILTER_HTTP_CONNECTION`     | `onFilterHttpConnection`  | `(urlString)` |
| `LWS_CALLBACK_CHECK_ACCESS_RIGHTS`        | `onCheckAccessRights`     | `(buf, lenArray)` |
| `LWS_CALLBACK_ADD_HEADERS`                | `onAddHeaders`            | `(buf, lenArray)` |
| `LWS_CALLBACK_PROCESS_HTML`               | `onProcessHtml`           | `(buf, lenArray)` |
| `LWS_CALLBACK_CLOSED_HTTP`                | `onClosedHttp`            | `()` |
| `LWS_CALLBACK_SERVER_NEW_CLIENT_INSTANTIATED` | `onServerNewClientInstantiated` | `()` |
| `LWS_CALLBACK_VERIFY_BASIC_AUTHORIZATION` | `onVerifyBasicAuthorization` | `(authString)` |
| `LWS_CALLBACK_SESSION_INFO`               | `onSessionInfo`           | `(buf, len)` |

## HTTP client

| Constant | Handler | Arguments |
|----------|---------|-----------|
| `LWS_CALLBACK_ESTABLISHED_CLIENT_HTTP`     | `onEstablishedClientHttp`    | `(responseCode)` |
| `LWS_CALLBACK_CLIENT_HTTP_WRITEABLE`       | `onClientHttpWriteable`      | `()` |
| `LWS_CALLBACK_RECEIVE_CLIENT_HTTP`         | `onReceiveClientHttp`        | `()` |
| `LWS_CALLBACK_RECEIVE_CLIENT_HTTP_READ`    | `onReceiveClientHttpRead`    | `(data, len)` |
| `LWS_CALLBACK_COMPLETED_CLIENT_HTTP`       | `onCompletedClientHttp`      | `()` |
| `LWS_CALLBACK_CLOSED_CLIENT_HTTP`          | `onClosedClientHttp`         | `()` |
| `LWS_CALLBACK_CLIENT_HTTP_BIND_PROTOCOL`   | `onClientHttpBindProtocol`   | `()` |
| `LWS_CALLBACK_CLIENT_HTTP_DROP_PROTOCOL`   | `onClientHttpDropProtocol`   | `()` |
| `LWS_CALLBACK_CLIENT_HTTP_REDIRECT`        | `onClientHttpRedirect`       | `(url, status)` |
| `LWS_CALLBACK_WSI_TX_CREDIT_GET`           | `onWsiTxCreditGet`           | `()` |

## Raw socket

| Constant | Handler | Arguments |
|----------|---------|-----------|
| `LWS_CALLBACK_RAW_ADOPT`        | `onRawAdopt`        | `()` |
| `LWS_CALLBACK_RAW_CONNECTED`    | `onRawConnected`    | `()` |
| `LWS_CALLBACK_RAW_RX`           | `onRawRx`           | `(data, len)` |
| `LWS_CALLBACK_RAW_WRITEABLE`    | `onRawWriteable`    | `()` |
| `LWS_CALLBACK_RAW_CLOSE`        | `onRawClose`        | `(errno)` |
| `LWS_CALLBACK_RAW_ADOPT_FILE`   | `onRawAdoptFile`    | `()` |
| `LWS_CALLBACK_RAW_RX_FILE`      | `onRawRxFile`       | `(data, len)` |
| `LWS_CALLBACK_RAW_WRITEABLE_FILE` | `onRawWriteableFile` | `()` |
| `LWS_CALLBACK_RAW_CLOSE_FILE`   | `onRawCloseFile`    | `()` |
| `LWS_CALLBACK_RAW_SKT_BIND_PROTOCOL` | `onRawSktBindProtocol` | `()` |
| `LWS_CALLBACK_RAW_SKT_DROP_PROTOCOL` | `onRawSktDropProtocol` | `()` |
| `LWS_CALLBACK_RAW_FILE_BIND_PROTOCOL` | `onRawFileBindProtocol` | `()` |
| `LWS_CALLBACK_RAW_FILE_DROP_PROTOCOL` | `onRawFileDropProtocol` | `()` |
| `LWS_CALLBACK_RAW_PROXY_CLI_RX` | `onRawProxyCliRx`   | `(data, len)` |
| `LWS_CALLBACK_RAW_PROXY_SRV_RX` | `onRawProxySrvRx`   | `(data, len)` |
| `LWS_CALLBACK_RAW_PROXY_CLI_CLOSE` | `onRawProxyCliClose` | `()` |
| `LWS_CALLBACK_RAW_PROXY_SRV_CLOSE` | `onRawProxySrvClose` | `()` |
| `LWS_CALLBACK_RAW_PROXY_CLI_WRITEABLE` | `onRawProxyCliWriteable` | `()` |
| `LWS_CALLBACK_RAW_PROXY_SRV_WRITEABLE` | `onRawProxySrvWriteable` | `()` |
| `LWS_CALLBACK_RAW_PROXY_CLI_ADOPT` | `onRawProxyCliAdopt` | `()` |
| `LWS_CALLBACK_RAW_PROXY_SRV_ADOPT` | `onRawProxySrvAdopt` | `()` |

## CGI / TLS / MQTT misc

| Constant | Handler | Arguments |
|----------|---------|-----------|
| `LWS_CALLBACK_CGI`                              | `onCgi` | `(data, len)` |
| `LWS_CALLBACK_CGI_TERMINATED`                   | `onCgiTerminated` | `()` |
| `LWS_CALLBACK_CGI_STDIN_DATA`                   | `onCgiStdinData` | `(data, len)` |
| `LWS_CALLBACK_CGI_STDIN_COMPLETED`              | `onCgiStdinCompleted` | `()` |
| `LWS_CALLBACK_CGI_PROCESS_ATTACH`               | `onCgiProcessAttach` | `(pid)` |
| `LWS_CALLBACK_CONNECTING`                       | `onConnecting` | `(fd)` |
| `LWS_CALLBACK_PROTOCOL_INIT`                    | `onProtocolInit` | `()` |
| `LWS_CALLBACK_PROTOCOL_DESTROY`                 | `onProtocolDestroy` | `()` |
| `LWS_CALLBACK_WSI_CREATE`                       | `onWsiCreate` | `()` |
| `LWS_CALLBACK_WSI_DESTROY`                      | `onWsiDestroy` | `()` |
| `LWS_CALLBACK_OPENSSL_LOAD_EXTRA_CLIENT_VERIFY_CERTS` | `onOpensslLoadExtraClientVerifyCerts` | `(sslPtr)` |
| `LWS_CALLBACK_OPENSSL_LOAD_EXTRA_SERVER_VERIFY_CERTS` | `onOpensslLoadExtraServerVerifyCerts` | `(sslPtr)` |
| `LWS_CALLBACK_OPENSSL_PERFORM_CLIENT_CERT_VERIFICATION` | `onOpensslPerformClientCertVerification` | `(sslPtr, preverifyOk)` |
| `LWS_CALLBACK_OPENSSL_PERFORM_SERVER_CERT_VERIFICATION` | `onOpensslPerformServerCertVerification` | `(sslPtr, preverifyOk)` |
| `LWS_CALLBACK_SSL_INFO`                         | `onSslInfo` | `(data, len)` |
| `LWS_CALLBACK_VHOST_CERT_AGING`                 | `onVhostCertAging` | `(daysLeft)` |
| `LWS_CALLBACK_VHOST_CERT_UPDATE`                | `onVhostCertUpdate` | `()` |
| `LWS_CALLBACK_TIMER`                            | `onTimer` | `()` |
| `LWS_CALLBACK_GET_THREAD_ID`                    | `onGetThreadId` | `()` |
| `LWS_CALLBACK_EVENT_WAIT_CANCELLED`             | `onEventWaitCancelled` | `()` |
| `LWS_CALLBACK_GS_EVENT`                         | `onGsEvent` | `(data, len)` |
| `LWS_CALLBACK_CHILD_CLOSING`                    | `onChildClosing` | `()` |
| `LWS_CALLBACK_MQTT_*`                           | `onMqtt*` | varies |

## Reasons handled internally (you usually don't write them)

`ADD_POLL_FD`, `DEL_POLL_FD`, `CHANGE_MODE_POLL_FD`, `LOCK_POLL`,
`UNLOCK_POLL` — see [event-loop.md](event-loop.md).
