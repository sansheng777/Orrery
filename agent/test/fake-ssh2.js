// A stand-in for the ssh2 package, used by test/pool.js. Registered as a module hook (node:module register)
// it sends every import of "ssh2" to this file; imported that way, its Client records each connection and
// answers every command with Client.reply(client, command), by default the address it is connected to.
// A reply is a list of chunks (exit code 0), { chunks, code }, or { hang: true } for a command that never ends.
import { EventEmitter } from "node:events";

export async function resolve(specifier, context, next) {
  return specifier === "ssh2" ? { url: import.meta.url, shortCircuit: true } : next(specifier, context);
}

export const clients = [];

export class Client extends EventEmitter {
  connect(opts) {
    this.opts = opts;
    this.ended = false;
    clients.push(this);
    if (Client.stall.has(opts.host)) return; // the handshake never finishes
    setImmediate(() => {
      // The host key comes before the login, as in a real handshake.
      if (opts.hostVerifier && opts.hostVerifier(Client.hostKey(opts.host)) === false) return this.emit("error", new Error("Host denied (verification failed)"));
      Client.refuse.has(opts.host) ? this.emit("error", new Error("All configured authentication methods failed")) : this.emit("ready");
    });
  }

  exec(command, cb) {
    if (Client.noChannel.has(this.opts.host)) return cb(new Error("(SSH) Channel open failure: "));
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.close = () => {};
    cb(null, stream);
    setImmediate(() => {
      const reply = Client.reply(this, command);
      const { chunks = [], code, hang } = Array.isArray(reply) ? { chunks: reply, code: 0 } : reply;
      for (const chunk of chunks) stream.emit("data", chunk);
      if (!hang) stream.emit("close", code);
    });
  }

  end() {
    if (!this.ended) {
      this.ended = true;
      setImmediate(() => this.emit("close"));
    }
    return this;
  }
}
Client.refuse = new Set(); // hosts whose login fails
Client.stall = new Set(); // hosts that never answer the handshake
Client.noChannel = new Set(); // hosts that refuse to open another channel (sshd MaxSessions)
Client.hostKeys = new Map(); // host -> the key blob it presents, when not the default
Client.hostKey = (host) => Client.hostKeys.get(host) || Buffer.from(`host key of ${host}`);
Client.reply = (client) => [Buffer.from(`${client.opts.host}:${client.opts.port}`)];

export default { Client, utils: {} };
