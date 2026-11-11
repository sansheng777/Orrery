// A stand-in for the ssh2 package, used by test/pool.js. Registered as a module hook (node:module register)
// it sends every import of "ssh2" to this file; imported that way, its Client records each connection and
// answers every command with Client.reply(client, command), by default the address it is connected to.
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
    setImmediate(() =>
      Client.refuse.has(opts.host) ? this.emit("error", new Error("All configured authentication methods failed")) : this.emit("ready"),
    );
  }

  exec(command, cb) {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.close = () => {};
    cb(null, stream);
    setImmediate(() => {
      for (const chunk of Client.reply(this, command)) stream.emit("data", chunk);
      stream.emit("close", 0);
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
Client.reply = (client) => [Buffer.from(`${client.opts.host}:${client.opts.port}`)];

export default { Client, utils: {} };
