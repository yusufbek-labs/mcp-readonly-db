// Generates a small, deterministic, entirely fictional online-shop database.
// Usage: npm run seed [-- path/to/shop.db]
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Alderan", "Brindle", "Cosima", "Dorwin", "Elspeth", "Fenwick", "Gwyneth", "Hobart", "Isolde", "Jorvik",
  "Kestrel", "Lunette", "Marisol", "Nyle", "Odalys", "Pemberly", "Quentin", "Rowena", "Sylvan", "Tamsin",
  "Ulric", "Verity", "Wendeline", "Xanthe", "Yarrow", "Zephyra"];
const LAST = ["Applewick", "Bramblethorn", "Cobblefield", "Dunmore-Fakeley", "Everlark", "Fizzlewhit", "Grumbleby",
  "Hollowpenny", "Inkwell", "Jumblecroft", "Kettleby", "Lollygag", "Mudgeon", "Nettlesworth", "Oddfellow",
  "Puddlesby", "Quibble", "Ravenscar-Nope", "Snodgrass", "Tumbleweed", "Umberfield", "Vexley", "Wobblesby", "Yonderly"];
const CITIES = [["Northhaven", "NL"], ["Port Examplia", "DE"], ["Westmarch", "SE"], ["Lake Placeholder", "FR"],
  ["Fakeford", "ES"], ["Mockton", "IT"], ["Testville", "PL"], ["Sampleburg", "BE"]];

const CATEGORIES = {
  Kitchen: ["Cast-Iron Skillet", "Ceramic Mug Set", "Bamboo Cutting Board", "Herb Scissors", "Glass Storage Jars", "Tea Infuser"],
  Office: ["Desk Organiser", "Dotted Notebook", "Gel Pen 10-Pack", "Monitor Riser", "Cable Clips", "Felt Desk Mat"],
  Outdoor: ["Enamel Camp Mug", "Folding Stool", "Dry Bag 10L", "Headlamp", "Trail Thermos", "Hammock Straps"],
  Home: ["Linen Cushion Cover", "Soy Candle", "Wall Hooks", "Wool Throw", "Brass Planter", "Door Draught Stopper"],
  Toys: ["Wooden Puzzle", "Marble Run Kit", "Card Game: Gnomes", "Kite", "Stacking Cups"],
};
const STATUSES = ["delivered", "delivered", "delivered", "shipped", "paid", "cancelled", "refunded"];

export function seedDatabase(file, { seed = 42, customers = 80, orders = 250 } = {}) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  for (const suffix of ["", "-journal", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      city TEXT NOT NULL,
      country TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents > 0),
      stock INTEGER NOT NULL CHECK (stock >= 0)
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL CHECK (status IN ('paid','shipped','delivered','cancelled','refunded')),
      ordered_at TEXT NOT NULL
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL
    );
    CREATE INDEX idx_orders_customer ON orders(customer_id);
    CREATE INDEX idx_items_order ON order_items(order_id);
  `);

  const date = (y0, m0, span) => {
    const d = new Date(Date.UTC(y0, m0, 1) + int(0, span) * 86400000);
    return d.toISOString().slice(0, 19).replace("T", " ");
  };

  db.exec("BEGIN");
  const insCust = db.prepare("INSERT INTO customers VALUES (?,?,?,?,?,?,?)");
  for (let id = 1; id <= customers; id++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const [city, country] = pick(CITIES);
    insCust.run(id, first, last, `${first}.${last}${id}@example.com`.toLowerCase(), city, country, date(2024, 0, 365));
  }

  const insProd = db.prepare("INSERT INTO products VALUES (?,?,?,?,?,?)");
  let pid = 0;
  for (const [category, names] of Object.entries(CATEGORIES)) {
    for (const name of names) {
      pid++;
      insProd.run(pid, `SKU-${String(pid).padStart(4, "0")}`, name, category, int(5, 120) * 100 - int(0, 1), int(0, 150));
    }
  }
  const prices = db.prepare("SELECT id, price_cents FROM products").all();

  const insOrder = db.prepare("INSERT INTO orders VALUES (?,?,?,?)");
  const insItem = db.prepare("INSERT INTO order_items VALUES (?,?,?,?,?)");
  let itemId = 0;
  for (let id = 1; id <= orders; id++) {
    insOrder.run(id, int(1, customers), pick(STATUSES), date(2025, 0, 600));
    const used = new Set();
    for (let n = int(1, 4); n > 0; n--) {
      const p = pick(prices);
      if (used.has(p.id)) continue;
      used.add(p.id);
      insItem.run(++itemId, id, p.id, int(1, 3), p.price_cents);
    }
  }
  db.exec("COMMIT");

  const counts = {};
  for (const t of ["customers", "products", "orders", "order_items"]) {
    counts[t] = db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
  }
  db.close();
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2] || process.env.MCP_DB_PATH || "./data/shop.db";
  const counts = seedDatabase(target);
  console.log(`Created ${path.resolve(target)}`);
  console.log(counts);
}
