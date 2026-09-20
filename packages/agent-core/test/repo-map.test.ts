import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractSymbolsFromSource, formatRepoMap, repoMapTool } from "../src/tools/repo-map.js";
import type { ToolContext } from "../src/types.js";

const ctx = (cwd: string): ToolContext => ({ cwd, todos: [] });

test("extractSymbolsFromSource extracts TypeScript classes, interfaces, types, functions, and methods", () => {
  const tsCode = `
export interface UserSession {
  id: string;
}

export type SessionId = string;

export class SessionService {
  constructor(private db: any) {}

  async loadSession(id: SessionId): Promise<UserSession | null> {
    return null;
  }
}

export function createService(): SessionService {
  return new SessionService({});
}

export const helperFn = (x: number) => x * 2;
`;

  const symbols = extractSymbolsFromSource(tsCode, "session.ts");
  assert.ok(symbols.some((s) => s.name === "UserSession" && s.kind === "interface"));
  assert.ok(symbols.some((s) => s.name === "SessionId" && s.kind === "type"));
  assert.ok(symbols.some((s) => s.name === "SessionService" && s.kind === "class"));
  assert.ok(symbols.some((s) => s.name === "loadSession" && s.kind === "method" && s.parent === "SessionService"));
  assert.ok(symbols.some((s) => s.name === "createService" && s.kind === "function"));
  assert.ok(symbols.some((s) => s.name === "helperFn" && s.kind === "function"));
});

test("extractSymbolsFromSource extracts Python classes, functions, and methods", () => {
  const pyCode = `
class DataProcessor:
    def process(self, data):
        pass

def standalone_fn():
    pass
`;

  const symbols = extractSymbolsFromSource(pyCode, "proc.py");
  assert.ok(symbols.some((s) => s.name === "DataProcessor" && s.kind === "class"));
  assert.ok(symbols.some((s) => s.name === "process" && s.kind === "method" && s.parent === "DataProcessor"));
  assert.ok(symbols.some((s) => s.name === "standalone_fn" && s.kind === "function"));
});

test("extractSymbolsFromSource extracts Go structs and funcs", () => {
  const goCode = `
type Server struct {
  port int
}

func NewServer() *Server {
  return &Server{}
}

func (s *Server) Start() error {
  return nil
}
`;

  const symbols = extractSymbolsFromSource(goCode, "server.go");
  assert.ok(symbols.some((s) => s.name === "Server" && s.kind === "struct"));
  assert.ok(symbols.some((s) => s.name === "NewServer" && s.kind === "function"));
  assert.ok(symbols.some((s) => s.name === "Start" && s.kind === "method"));
});

test("extractSymbolsFromSource extracts Rust structs, enums, traits, and impl methods", () => {
  const rsCode = `
pub struct Config {
    pub port: u16,
}

pub enum State {
    Running,
    Stopped,
}

pub trait Runner {
    fn run(&self);
}

impl Runner for Config {
    fn run(&self) {
        println!("run");
    }
}
`;

  const symbols = extractSymbolsFromSource(rsCode, "lib.rs");
  assert.ok(symbols.some((s) => s.name === "Config" && s.kind === "struct"));
  assert.ok(symbols.some((s) => s.name === "State" && s.kind === "enum"));
  assert.ok(symbols.some((s) => s.name === "Runner" && s.kind === "trait"));
  assert.ok(symbols.some((s) => s.name === "run" && s.kind === "method" && s.parent === "Config"));
});

test("extractSymbolsFromSource extracts Java and Kotlin types and methods", () => {
  const javaCode = `
public class PaymentGateway {
    public void processPayment(double amount) {
    }
}
`;
  const jSymbols = extractSymbolsFromSource(javaCode, "PaymentGateway.java");
  assert.ok(jSymbols.some((s) => s.name === "PaymentGateway" && s.kind === "class"));
  assert.ok(jSymbols.some((s) => s.name === "processPayment" && s.kind === "method" && s.parent === "PaymentGateway"));

  const ktCode = `
class UserService {
    fun fetchUser(id: String): User {
    }
}
`;
  const ktSymbols = extractSymbolsFromSource(ktCode, "UserService.kt");
  assert.ok(ktSymbols.some((s) => s.name === "UserService" && s.kind === "class"));
  assert.ok(ktSymbols.some((s) => s.name === "fetchUser" && s.kind === "method" && s.parent === "UserService"));
});

test("extractSymbolsFromSource extracts C++ and C# classes and methods", () => {
  const cppCode = `
class SocketManager {
    void connectToServer(const char* host);
};
`;
  const cppSymbols = extractSymbolsFromSource(cppCode, "socket.cpp");
  assert.ok(cppSymbols.some((s) => s.name === "SocketManager" && s.kind === "class"));
  assert.ok(cppSymbols.some((s) => s.name === "connectToServer" && s.kind === "method"));

  const csCode = `
public class OrderService {
    public async Task<Order> CreateOrder(OrderRequest req) {
    }
}
`;
  const csSymbols = extractSymbolsFromSource(csCode, "OrderService.cs");
  assert.ok(csSymbols.some((s) => s.name === "OrderService" && s.kind === "class"));
  assert.ok(csSymbols.some((s) => s.name === "CreateOrder" && s.kind === "method" && s.parent === "OrderService"));
});

test("extractSymbolsFromSource extracts Ruby and PHP symbols", () => {
  const rbCode = `
class OrderProcessor
  def execute_order(order_id)
  end
end
`;
  const rbSymbols = extractSymbolsFromSource(rbCode, "processor.rb");
  assert.ok(rbSymbols.some((s) => s.name === "OrderProcessor" && s.kind === "class"));
  assert.ok(rbSymbols.some((s) => s.name === "execute_order" && s.kind === "method" && s.parent === "OrderProcessor"));

  const phpCode = `
class CacheClient {
    public function getCachedItem(string $key) {
    }
}
`;
  const phpSymbols = extractSymbolsFromSource(phpCode, "cache.php");
  assert.ok(phpSymbols.some((s) => s.name === "CacheClient" && s.kind === "class"));
  assert.ok(phpSymbols.some((s) => s.name === "getCachedItem" && s.kind === "method" && s.parent === "CacheClient"));
});

test("extractSymbolsFromSource skips constructors, super, and binary files", () => {
  const tsCode = `
class MyClass {
  constructor() {}
  super() {}
  realMethod() {}
}
`;
  const symbols = extractSymbolsFromSource(tsCode, "foo.ts");
  assert.ok(!symbols.some((s) => s.name === "constructor"));
  assert.ok(!symbols.some((s) => s.name === "super"));
  assert.ok(symbols.some((s) => s.name === "realMethod" && s.kind === "method"));

  const binaryCode = "abc\0def";
  assert.deepEqual(extractSymbolsFromSource(binaryCode, "binary.ts"), []);
});

test("repoMapTool single-file mode extracts symbols directly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-repomap-file-"));
  try {
    const filePath = join(dir, "single.ts");
    writeFileSync(filePath, "export class MySoloClass { doSolo() {} }");

    const res = await repoMapTool.execute({ path: filePath }, ctx(dir));
    assert.ok(res.includes("class MySoloClass"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repoMapTool walks workspace, honors ignore dirs, and filters by query", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-repomap-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "lib"), { recursive: true });

    writeFileSync(
      join(dir, "src", "auth.ts"),
      `
export class AuthClient {
  login() {}
}
export function getAuth() {}
`,
    );

    writeFileSync(
      join(dir, "node_modules", "lib", "index.ts"),
      `export class IgnoredClass {}`,
    );

    // Full map
    const full = await repoMapTool.execute({}, ctx(dir));
    assert.ok(full.includes("src/auth.ts:"));
    assert.ok(full.includes("class AuthClient"));
    assert.ok(full.includes("function getAuth"));
    assert.ok(!full.includes("IgnoredClass"), "node_modules must be excluded");

    // Filter by query
    const filtered = await repoMapTool.execute({ query: "login" }, ctx(dir));
    assert.ok(filtered.includes("src/auth.ts:"));
    assert.ok(filtered.includes(".login()"));
    assert.ok(!filtered.includes("getAuth"));

    // Query with no matches
    const empty = await repoMapTool.execute({ query: "nonexistent" }, ctx(dir));
    assert.equal(empty, "No matching symbols found.");

    // Direct formatRepoMap with empty symbol files
    const noSyms = formatRepoMap([{ relPath: "empty.ts", symbols: [] }]);
    assert.equal(noSyms, "No matching symbols found.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
