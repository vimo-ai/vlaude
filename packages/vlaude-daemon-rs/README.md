# vlaude-daemon-rs

Rust implementation of the Vlaude daemon, replacing the deprecated NestJS version (`../vlaude-daemon`).

## Features

- Connects to `vlaude-server` via Socket.IO
- Redis service discovery (auto-discover and switch servers)
- Shares core logic with VlaudeKit via `vlaude-core`
- Session file watching and real-time sync

## Usage

```bash
# Direct connection to server
cargo run -- --server https://localhost:10005

# With Redis service discovery
cargo run -- --redis-host localhost --redis-port 6379

# With custom hostname
cargo run -- --hostname "MyMac" --redis-host localhost
```

## Architecture

```
vlaude-daemon-rs
    │
    └── depends on: vlaude-core/
            ├── daemon-logic/     # Core daemon logic
            ├── socket-client/    # Socket.IO + Redis ServiceRegistry
            └── session-reader/   # JSONL parsing
```

## Related

- `../vlaude-core` - Rust core library
- `../vlaude-server` - Central server
- `../vlaude-cli` - TS CLI wrapper for Claude (different purpose!)
