const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// --- JSON "database" paths ---
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Helpers to read/write DB
function loadDb() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      const empty = { books: [], sellers: [], stockMovements: [], sales: [] };
      fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2), 'utf8');
      return empty;
    }
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('Error loading DB:', err);
    return { books: [], sellers: [], stockMovements: [], sales: [] };
  }
}

function saveDb(db) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving DB:', err);
  }
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Utility: build "Excel-friendly" TSV (tab-separated)
function toCsv(headers, rows) {
  const sep = '\t';
  const esc = v => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  };

  const headerLine = headers.map(esc).join(sep);
  const bodyLines = rows.map(r => r.map(esc).join(sep));
  return [headerLine, ...bodyLines].join('\n');
}

// =========================
//  Books
// =========================

// Search books (by q: title/author/publisher/barcode/shelf)
app.get('/api/books/search', (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const db = loadDb();
  let books = db.books || [];
  if (q) {
    books = books.filter(b => {
      const fields = [
        b.title || '',
        b.author || '',
        b.publisher || '',
        b.barcode || '',
        b.shelf || ''
      ].join(' ').toLowerCase();
      return fields.includes(q);
    });
  }
  res.json(books);
});

// Get book by barcode
app.get('/api/books/by-barcode/:barcode', (req, res) => {
  const code = (req.params.barcode || '').toString();
  const db = loadDb();
  const book = (db.books || []).find(b => b.barcode === code);
  if (!book) {
    return res.status(404).json({ success: false, error: 'ספר לא נמצא' });
  }
  res.json(book);
});

// List all books
app.get('/api/books', (req, res) => {
  const db = loadDb();
  res.json(db.books || []);
});

// Create OR update a book
// אם body כולל id → עדכון, אחרת יצירה
app.post('/api/books', (req, res) => {
  let {
    id,
    barcode,
    title,
    author,
    publisher,
    shelf,
    price,
    initialQty
  } = req.body || {};

  const db = loadDb();
  const books = db.books || [];

  if (!title || !String(title).trim()) {
    return res.status(400).json({ success: false, error: 'חסר שם ספר' });
  }

  title = String(title).trim();
  author = author ? String(author) : '';
  publisher = publisher ? String(publisher) : '';
  shelf = shelf ? String(shelf) : '';

  price = price != null && price !== '' ? Number(price) : 0;
  if (isNaN(price) || price < 0) {
    return res.status(400).json({ success: false, error: 'מחיר לא תקין' });
  }

  initialQty = initialQty != null && initialQty !== '' ? parseInt(initialQty, 10) : 0;
  if (isNaN(initialQty) || initialQty < 0) {
    return res.status(400).json({ success: false, error: 'כמות התחלתית לא תקינה' });
  }

  barcode = barcode ? String(barcode).trim() : '';

  // ---- עדכון ספר קיים ----
  if (id) {
    id = Number(id);
    const existing = books.find(b => b.id === id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'ספר לא נמצא לעדכון' });
    }

    // ברקוד חדש חייב להיות ייחודי
    if (barcode && barcode !== existing.barcode) {
      if (books.some(b => b.barcode === barcode)) {
        return res.status(400).json({ success: false, error: 'כבר קיים ספר עם ברקוד זה' });
      }
    }

    if (!barcode) {
      barcode = existing.barcode;
    }

    existing.title = title;
    existing.author = author;
    existing.publisher = publisher;
    existing.shelf = shelf;
    existing.price = price;
    existing.barcode = barcode;

    db.books = books;
    saveDb(db);
    return res.json({ success: true, book: existing });
  }

  // ---- יצירת ספר חדש ----
  if (barcode && books.some(b => b.barcode === barcode)) {
    return res.status(400).json({ success: false, error: 'כבר קיים ספר עם ברקוד זה' });
  }

  if (!barcode) {
    let newCode;
    do {
      newCode =
        'B' +
        Date.now().toString().slice(-8) +
        Math.floor(Math.random() * 1000)
          .toString()
          .padStart(3, '0');
    } while (books.some(b => b.barcode === newCode));
    barcode = newCode;
  }

  const nextId = books.length ? Math.max(...books.map(b => b.id || 0)) + 1 : 1;
  const newBook = {
    id: nextId,
    barcode,
    title,
    author,
    publisher,
    shelf,
    price,
    initial_qty: initialQty,
    current_qty: initialQty
  };
  books.push(newBook);
  db.books = books;
  saveDb(db);
  return res.json({ success: true, book: newBook });
});

// מחיקת ספרים (אחד או כמה ביחד) לפי ids
app.post('/api/books/delete', (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ success: false, error: 'לא התקבלו ספרים למחיקה' });
  }

  const db = loadDb();
  let books = db.books || [];
  const before = books.length;

  const idSet = new Set(ids.map(x => Number(x)));
  books = books.filter(b => !idSet.has(Number(b.id)));

  const deletedCount = before - books.length;
  db.books = books;
  saveDb(db);

  res.json({ success: true, deletedCount });
});

// =========================
//  Sellers
// =========================

app.post('/api/sellers', (req, res) => {
  let { name, barcode } = req.body || {};
  const db = loadDb();
  const sellers = db.sellers || [];

  name = name ? String(name).trim() : '';
  barcode = barcode ? String(barcode).trim() : '';

  if (!name) {
    return res.status(400).json({ success: false, error: 'חסר שם מוכר' });
  }
  if (!barcode) {
    return res.status(400).json({ success: false, error: 'חסר ברקוד למוכר' });
  }
  if (sellers.some(s => s.barcode === barcode)) {
    return res.status(400).json({ success: false, error: 'כבר קיים מוכר עם ברקוד זה' });
  }

  const nextId = sellers.length ? Math.max(...sellers.map(s => s.id || 0)) + 1 : 1;
  const now = new Date().toISOString();

  const seller = {
    id: nextId,
    name,
    barcode,
    created_at: now
  };

  sellers.push(seller);
  db.sellers = sellers;
  saveDb(db);
  res.json({ success: true, seller });
});

// Search sellers
app.get('/api/sellers/search', (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const db = loadDb();
  let sellers = db.sellers || [];

  if (q) {
    sellers = sellers.filter(s => {
      const fields = [
        s.name || '',
        s.barcode || ''
      ].join(' ').toLowerCase();
      return fields.includes(q);
    });
  }

  res.json(sellers);
});

// Get seller by barcode (לשימוש בעסקה מהירה)
app.get('/api/sellers/by-barcode/:barcode', (req, res) => {
  const code = (req.params.barcode || '').toString();
  const db = loadDb();
  const sellers = db.sellers || [];
  const seller = sellers.find(s => s.barcode === code);
  if (!seller) {
    return res.status(404).json({ success: false, error: 'מוכר לא נמצא' });
  }
  res.json(seller);
});

// =========================
//  Stock movements
// =========================

// Add incoming stock (restock)
app.post('/api/stock/in', (req, res) => {
  let { barcode, qty, note } = req.body || {};
  barcode = barcode ? String(barcode).trim() : '';

  qty = qty != null && qty !== '' ? parseInt(qty, 10) : 0;
  if (!barcode || isNaN(qty) || qty <= 0) {
    return res.status(400).json({ success: false, error: 'ברקוד או כמות לא תקינים' });
  }

  const db = loadDb();
  const books = db.books || [];
  const book = books.find(b => b.barcode === barcode);
  if (!book) {
    return res.status(404).json({ success: false, error: 'ספר לא נמצא' });
  }

  const now = new Date().toISOString();
  book.current_qty = (book.current_qty || 0) + qty;

  if (!db.stockMovements) db.stockMovements = [];
  const movements = db.stockMovements;
  const nextId = movements.length ? Math.max(...movements.map(m => m.id || 0)) + 1 : 1;

  movements.push({
    id: nextId,
    type: 'in',
    bookBarcode: barcode,
    qty,
    note: note ? String(note) : '',
    date: now
  });

  db.books = books;
  db.stockMovements = movements;
  saveDb(db);

  res.json({ success: true, book });
});

// =========================
//  Sales
// =========================

// Single-book sale (POS)
app.post('/api/stock/sale', (req, res) => {
  let { bookBarcode, sellerBarcode, qty } = req.body || {};
  bookBarcode = bookBarcode ? String(bookBarcode).trim() : '';
  sellerBarcode = sellerBarcode ? String(sellerBarcode).trim() : '';

  qty = qty != null && qty !== '' ? parseInt(qty, 10) : 0;
  if (!bookBarcode || !sellerBarcode || isNaN(qty) || qty <= 0) {
    return res.status(400).json({ success: false, error: 'נתוני מכירה לא תקינים' });
  }

  const db = loadDb();
  const books = db.books || [];
  const sellers = db.sellers || [];

  const book = books.find(b => b.barcode === bookBarcode);
  if (!book) {
    return res.status(404).json({ success: false, error: 'ספר לא נמצא' });
  }

  const seller = sellers.find(s => s.barcode === sellerBarcode);
  if (!seller) {
    return res.status(404).json({ success: false, error: 'מוכר לא נמצא' });
  }

  const currentQty = book.current_qty || 0;
  if (currentQty < qty) {
    return res.status(400).json({ success: false, error: 'אין מספיק מלאי למכירה' });
  }

  const now = new Date().toISOString();
  const price = book.price || 0;
  const total = price * qty;

  book.current_qty = currentQty - qty;

  if (!db.stockMovements) db.stockMovements = [];
  const movements = db.stockMovements;
  const nextMoveId = movements.length ? Math.max(...movements.map(m => m.id || 0)) + 1 : 1;
  movements.push({
    id: nextMoveId,
    type: 'out',
    bookBarcode: bookBarcode,
    qty,
    note: `מכירה למוכר ${seller.name}`,
    date: now
  });

  if (!db.sales) db.sales = [];
  const sales = db.sales;
  const nextSaleId = sales.length ? Math.max(...sales.map(s => s.id || 0)) + 1 : 1;

  sales.push({
    id: nextSaleId,
    bookBarcode,
    sellerBarcode,
    qty,
    total,
    date: now
  });

  db.books = books;
  db.stockMovements = movements;
  db.sales = sales;
  saveDb(db);

  res.json({
    success: true,
    bookTitle: book.title,
    sellerName: seller.name,
    qty,
    total
  });
});

// Multi-book sale – לעסקה מהירה ממסך הבית
app.post('/api/sales/quick', (req, res) => {
  const { sellerBarcode, items } = req.body || {};

  const sellerCode = sellerBarcode ? String(sellerBarcode).trim() : '';
  if (!sellerCode) {
    return res.status(400).json({ success: false, error: 'חסר ברקוד מוכר' });
  }
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ success: false, error: 'אין פריטים לעסקה' });
  }

  const db = loadDb();
  const books = db.books || [];
  const sellers = db.sellers || [];
  if (!db.stockMovements) db.stockMovements = [];
  if (!db.sales) db.sales = [];

  const seller = sellers.find(s => s.barcode === sellerCode);
  if (!seller) {
    return res.status(404).json({ success: false, error: 'מוכר לא נמצא' });
  }

  const normalizedItems = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    const barcode = (item.barcode || '').toString().trim();
    let qty = item.qty != null && item.qty !== '' ? parseInt(item.qty, 10) : 0;

    if (!barcode || isNaN(qty) || qty <= 0) {
      return res.status(400).json({
        success: false,
        error: `שורה ${i + 1} בעסקה לא תקינה (ברקוד/כמות)`
      });
    }

    const book = books.find(b => b.barcode === barcode);
    if (!book) {
      return res.status(404).json({
        success: false,
        error: `ספר עם ברקוד ${barcode} לא נמצא`
      });
    }

    const currentQty = book.current_qty || 0;
    if (currentQty < qty) {
      return res.status(400).json({
        success: false,
        error: `מלאי לא מספיק לספר '${book.title || ''}'`
      });
    }

    normalizedItems.push({ book, barcode, qty });
  }

  const now = new Date().toISOString();
  const movements = db.stockMovements;
  const sales = db.sales;

  let nextMoveId = movements.length ? Math.max(...movements.map(m => m.id || 0)) + 1 : 1;
  let nextSaleId = sales.length ? Math.max(...sales.map(s => s.id || 0)) + 1 : 1;

  let totalAmount = 0;
  let totalQty = 0;

  normalizedItems.forEach(({ book, barcode, qty }) => {
    const price = book.price || 0;
    const rowTotal = price * qty;

    book.current_qty = (book.current_qty || 0) - qty;

    movements.push({
      id: nextMoveId++,
      type: 'out',
      bookBarcode: barcode,
      qty,
      note: `עסקה מהירה ממסך הבית למוכר ${seller.name}`,
      date: now
    });

    sales.push({
      id: nextSaleId++,
      bookBarcode: barcode,
      sellerBarcode: sellerCode,
      qty,
      total: rowTotal,
      date: now
    });

    totalAmount += rowTotal;
    totalQty += qty;
  });

  db.books = books;
  db.stockMovements = movements;
  db.sales = sales;
  saveDb(db);

  res.json({
    success: true,
    totalAmount,
    totalQty,
    itemsCount: normalizedItems.length
  });
});

// =========================
//  Reports
// =========================

app.get('/api/reports/stock-csv', (req, res) => {
  const db = loadDb();
  const books = db.books || [];

  const headers = [
    'ID',
    'ברקוד',
    'שם ספר',
    'מחבר',
    'הוצאה',
    'מדף',
    'מחיר',
    'כמות התחלתית',
    'כמות נוכחית'
  ];

  const rows = books.map(b => [
    b.id || '',
    b.barcode || '',
    b.title || '',
    b.author || '',
    b.publisher || '',
    b.shelf || '',
    b.price || 0,
    b.initial_qty || 0,
    b.current_qty || 0
  ]);

  const csv = toCsv(headers, rows);
  res.setHeader('Content-Type', 'text/tab-separated-values; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="stock.tsv"');
  res.send(csv);
});

app.get('/api/reports/sales-csv', (req, res) => {
  const db = loadDb();
  const books = db.books || [];
  const sellers = db.sellers || [];
  const sales = db.sales || [];

  const headers = [
    'ID מכירה',
    'תאריך',
    'ברקוד ספר',
    'שם ספר',
    'ברקוד מוכר',
    'שם מוכר',
    'כמות',
    'סכום כולל'
  ];

  const rows = sales.map(s => {
    const book = books.find(b => b.barcode === s.bookBarcode) || {};
    const seller = sellers.find(x => x.barcode === s.sellerBarcode) || {};
    return [
      s.id || '',
      s.date || '',
      s.bookBarcode || '',
      book.title || '',
      s.sellerBarcode || '',
      seller.name || '',
      s.qty || 0,
      s.total || 0
    ];
  });

  const csv = toCsv(headers, rows);
  res.setHeader('Content-Type', 'text/tab-separated-values; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sales.tsv"');
  res.send(csv);
});

// =========================
//  Import from Excel-like TSV
// =========================

// import.html צריך לקרוא לכתובת הזו עם POST JSON: { rows: [...] }
app.post('/api/import/books-tsv', (req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows)) {
    return res.status(400).json({ success: false, error: 'פורמט קלט לא תקין (rows)' });
  }

  const db = loadDb();
  let books = db.books || [];
  if (!db.stockMovements) db.stockMovements = [];
  let movements = db.stockMovements;

  let nextBookId = books.length ? Math.max(...books.map(b => b.id || 0)) + 1 : 1;
  let nextMoveId = movements.length ? Math.max(...movements.map(m => m.id || 0)) + 1 : 1;

  let insertedCount = 0;
  let skippedExisting = 0;
  const errors = [];

  rows.forEach((row, index) => {
    if (!row) return;
    let {
      barcode,
      title,
      author,
      publisher,
      shelf,
      price,
      initialQty
    } = row;

    title = title ? String(title).trim() : '';
    if (!title) {
      errors.push(`שורה ${index + 1}: חסר שם ספר`);
      return;
    }

    barcode = barcode ? String(barcode).trim() : '';
    if (!barcode) {
      errors.push(`שורה ${index + 1}: חסר ברקוד`);
      return;
    }

    if (books.some(b => b.barcode === barcode)) {
      skippedExisting++;
      return;
    }

    author = author ? String(author) : '';
    publisher = publisher ? String(publisher) : '';
    shelf = shelf ? String(shelf) : '';
    price = price != null && price !== '' ? Number(price) : 0;
    if (isNaN(price) || price < 0) {
      errors.push(`שורה ${index + 1}: מחיר לא תקין`);
      return;
    }

    initialQty = initialQty != null && initialQty !== '' ? parseInt(initialQty, 10) : 0;
    if (isNaN(initialQty) || initialQty < 0) {
      errors.push(`שורה ${index + 1}: כמות התחלתית לא תקינה`);
      return;
    }

    const newBook = {
      id: nextBookId++,
      barcode,
      title,
      author,
      publisher,
      shelf,
      price,
      initial_qty: initialQty,
      current_qty: initialQty
    };
    books.push(newBook);

    if (initialQty > 0) {
      movements.push({
        id: nextMoveId++,
        type: 'in',
        bookBarcode: barcode,
        qty: initialQty,
        note: 'ייבוא התחלתי',
        date: new Date().toISOString()
      });
    }

    insertedCount++;
  });

  db.books = books;
  db.stockMovements = movements;
  saveDb(db);

  res.json({
    success: true,
    insertedCount,
    skippedExisting,
    errors
  });
});

// =========================
//  Static
// =========================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Bookstore app listening on http://localhost:${PORT}`);
});
