const path = require("node:path");
const { Resvg } = require("@resvg/resvg-js");

const FONT_FILE = path.join(__dirname, "..", "assets", "fonts", "NotoSansCJKtc-Regular.otf");
const WIDTH = 720;

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function textUnits(value) {
  return [...String(value)].reduce((sum, char) => sum + (/^[\x00-\x7f]$/.test(char) ? 0.58 : 1), 0);
}

function wrapText(value, maxUnits, maxLines = 3) {
  const source = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!source) return ["—"];
  const lines = [];
  let current = "";
  for (const char of source) {
    if (textUnits(current + char) > maxUnits && current) {
      lines.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const shortened = lines.slice(0, maxLines);
  shortened[maxLines - 1] = `${[...shortened[maxLines - 1]].slice(0, -1).join("")}…`;
  return shortened;
}

function money(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) throw new Error("收據金額無效");
  return `${currency === "ASD" ? "ASD " : "NT$"}${Math.round(value).toLocaleString("zh-TW")}`;
}

function taipeiTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error("收據時間無效");
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function buildTipReceiptData({ tipData, allocations, staffNames, payerName }) {
  const payment = String(tipData?.paymentMethod || "已確認付款");
  const items = allocations.flatMap((allocation, index) => {
    const to = staffNames[index] || allocation.staffId || "陪陪";
    return allocation.lines?.length
      ? allocation.lines.map((line) => ({
        to, name: line.name, quantity: Number(line.quantity || 1),
        amount: Number(line.subtotal || line.price * line.quantity || 0),
      }))
      : [{ to, name: allocation.item || "打賞", quantity: 1, amount: Number(allocation.amount || 0) }];
  });
  return {
    kind: "tip",
    reference: tipData?.flowId || tipData?.tipId || tipData?.createdAt || "打賞紀錄",
    payer: tipData?.broadcastAnonymous ? "匿名闆闆" : payerName,
    recipient: staffNames.join("、"),
    details: allocations.flatMap((allocation) =>
      allocation.lines?.length
        ? allocation.lines.map((line) => `${line.name} × ${line.quantity || 1}`)
        : [allocation.item || "打賞"],
    ).join("、"),
    items,
    amount: allocations.reduce((sum, allocation) => sum + Number(allocation.amount || 0), 0),
    currency: /錢包|儲值|ASD|餘額/u.test(payment) ? "ASD" : "TWD",
    payment,
    time: tipData?.createdAt,
  };
}

function buildOrderReceiptData({ order, payerName, playerNames, amount }) {
  const payment = String(order.payment_method || "已確認付款");
  return {
    kind: "order",
    reference: order.order_no || order.id,
    payer: payerName,
    recipient: playerNames.join("、") || "待選陪陪",
    details: order.service || order.order_item || "陪玩訂單",
    items: [{ to: playerNames.join("、") || "待選陪陪", name: order.service || order.order_item || "陪玩訂單", quantity: 1, amount }],
    amount,
    currency: /錢包|儲值|ASD|餘額/u.test(payment) ? "ASD" : "TWD",
    payment,
    time: order.paid_at || new Date(),
  };
}

function receiptSvg({ kind, reference, payer, recipient, details, items, amount, currency = "TWD", payment, time, shop = "深夜不關燈" }) {
  if (!["order", "tip"].includes(kind)) throw new Error("收據類型無效");
  const isTip = kind === "tip";
  const recipients = String(recipient || "待選陪陪").split("、").filter(Boolean);
  const lines = Array.isArray(items) && items.length
    ? items.slice(0, 30)
    : [{ to: recipients[0], name: details || (isTip ? "打賞" : "陪玩訂單"), quantity: 1, amount }];
  const safeMoney = money(amount, currency);
  const label = isTip ? "打賞" : "訂單";
  let y = 463;
  const recipientRows = recipients.slice(0, 12).map((name, index) => {
    const row = `<text x="82" y="${y}" class="muted">${String(index + 1).padStart(2, "0")}</text><text x="126" y="${y}" class="bold">${escapeXml(wrapText(name, 25, 1)[0])}</text>`;
    y += 43;
    return row;
  }).join("");
  y += 24;
  const detailsTop = y;
  y += 65;
  const itemRows = lines.map((item) => {
    const itemName = wrapText(item.name || details || label, 20, 2);
    const to = wrapText(item.to || recipients[0] || "陪陪", 30, 1)[0];
    const row = `<text x="82" y="${y}" class="muted">${escapeXml(to)}</text>`;
    y += 38;
    const title = itemName.map((name, index) => `<text x="82" y="${y + index * 32}" class="bold">${escapeXml(name)}</text>`).join("");
    const subtotal = Number(item.amount ?? 0);
    const qty = Math.max(1, Number(item.quantity || 1));
    const amountText = Number.isFinite(subtotal) && subtotal >= 0 ? money(subtotal, currency) : "—";
    const price = `<text x="637" y="${y + (itemName.length - 1) * 32}" class="bold" text-anchor="end">${escapeXml(amountText)}</text>`;
    const quantity = `<text x="82" y="${y + itemName.length * 32}" class="muted">×${qty}</text>`;
    y += itemName.length * 32 + 66;
    return row + title + price + quantity;
  }).join("");
  const summaryY = y + 24;
  const paperBottom = summaryY + 222;
  const height = paperBottom + 100;
  const topTeeth = Array.from({ length: 58 }, (_, i) => `${42 + i * 11},${i % 2 ? 34 : 25}`).join(" ");
  const bottomTeeth = Array.from({ length: 58 }, (_, i) => `${678 - i * 11},${i % 2 ? paperBottom + 9 : paperBottom}`).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
    <defs><linearGradient id="paper" x2="0" y2="1"><stop stop-color="#fcfaf5"/><stop offset="1" stop-color="#f4efe2"/></linearGradient></defs>
    <style>text{font-family:'Noto Sans CJK TC',sans-serif}.muted{fill:#777066;font-size:21px}.bold{font-size:25px;font-weight:700}</style>
    <rect width="720" height="${height}" fill="#151413"/>
    <polygon points="42,34 ${topTeeth} 678,34 ${bottomTeeth} 42,${paperBottom}" fill="url(#paper)"/>
    <text x="360" y="128" text-anchor="middle" font-size="46" font-style="italic" font-weight="700">AS</text>
    <text x="360" y="174" text-anchor="middle" font-size="30" font-weight="700" letter-spacing="8">${label}收據</text>
    <text x="360" y="204" text-anchor="middle" fill="#827567" font-size="18" letter-spacing="7">${isTip ? "TIP RECEIPT" : "ORDER RECEIPT"}</text>
    <g transform="rotate(-14 580 115)"><circle cx="580" cy="115" r="57" fill="none" stroke="#c53228" stroke-width="2"/><circle cx="580" cy="115" r="52" fill="none" stroke="#c53228" stroke-width="2"/><text x="580" y="114" text-anchor="middle" fill="#c53228" font-size="25">已付款</text><text x="580" y="139" text-anchor="middle" fill="#c53228" font-size="15" letter-spacing="3">PAID</text></g>
    <rect x="80" y="239" width="560" height="59" rx="6" fill="none" stroke="#c53228" stroke-width="2"/>
    <circle cx="222" cy="268" r="14" fill="#c53228"/><text x="222" y="276" fill="#fff" text-anchor="middle" font-size="19">✓</text>
    <text x="244" y="277" fill="#b62720" font-size="23" font-weight="700">${label}已使用${escapeXml(wrapText(payment || "已確認付款", 17, 1)[0])}付款</text>
    <path d="M80 328 H640" stroke="#c6bca9" stroke-dasharray="6 5"/>
    <text x="82" y="376" class="muted">${isTip ? "打賞人" : "闆闆"}</text>
    <text x="638" y="376" class="bold" text-anchor="end">${escapeXml(wrapText(payer || "闆闆", 19, 1)[0])}</text>
    <text x="82" y="426" class="muted">${isTip ? "受賞陪陪" : "接單陪陪"}</text>
    ${recipientRows}
    <path d="M80 ${detailsTop - 35} H640" stroke="#c6bca9" stroke-dasharray="6 5"/>
    <text x="82" y="${detailsTop + 20}" class="muted">${isTip ? "打賞明細" : "訂單明細"}</text>
    ${itemRows}
    <path d="M80 ${summaryY} H640" stroke="#2d2a26" stroke-width="3"/>
    <path d="M80 ${summaryY + 5} H640" stroke="#2d2a26" stroke-width="1"/>
    <text x="82" y="${summaryY + 76}" font-size="24" letter-spacing="6">總金額</text>
    <text x="638" y="${summaryY + 78}" text-anchor="end" font-size="49" font-weight="700">${escapeXml(safeMoney)}</text>
    <path d="M80 ${summaryY + 104} H640" stroke="#c6bca9" stroke-dasharray="6 5"/>
    <text x="360" y="${summaryY + 150}" text-anchor="middle" font-size="20">${escapeXml(taipeiTime(time))}</text>
    <text x="360" y="${summaryY + 184}" text-anchor="middle" fill="#827567" font-size="19">感謝您的支持 · ${escapeXml(shop)}</text>
    <text x="360" y="${height - 39}" text-anchor="middle" fill="#bd9a58" font-size="24">${escapeXml(wrapText(reference || "—", 26, 1)[0])}</text>
  </svg>`;
}

function renderReceiptPng(data) {
  const svg = receiptSvg(data);
  const renderer = new Resvg(svg, {
    font: { fontFiles: [FONT_FILE], loadSystemFonts: false, defaultFontFamily: "Noto Sans CJK TC" },
  });
  return renderer.render().asPng();
}

module.exports = {
  escapeXml,
  wrapText,
  buildTipReceiptData,
  buildOrderReceiptData,
  receiptSvg,
  renderReceiptPng,
};
