const path = require("node:path");
const { Resvg } = require("@resvg/resvg-js");

const FONT_FILE = path.join(__dirname, "..", "assets", "fonts", "NotoSansCJKtc-Regular.otf");
const PAPER_WIDTH = 500;
// The 𝓐𝓢 mark uses two STIX Two Math glyph outlines.
// Copyright 2001-2021 The STIX Fonts Project Authors; SIL Open Font License 1.1.
const AS_MARK = `<g transform="translate(220 77) scale(0.043 -0.043)"><path d="M512 220C500 168 489 116 489 79C489 31 518 -14 591 -14C650 -14 738 22 784 69L759 102C731 80 702 62 678 62C651 62 642 78 642 112C642 147 651 192 658 226L733 595C737 613 760 625 791 633L792 673C645 656 494 624 407 496C271 296 222 37 101 37C47 37 98 128 22 128C-21 128 -39 95 -39 65C-39 15 4 -14 67 -14C201 -14 269 91 331 220ZM355 271C396 358 426 421 452 464C492 529 527 556 590 574L593 569L524 273C524 272 524 272 524 271Z"/><path transform="translate(827 0)" d="M385 468C401 465 417 464 428 464C504 464 557 508 557 570C557 642 484 669 397 669C274 669 133 616 133 480C133 370 227 327 289 293C361 254 389 225 389 169C389 88 331 40 233 40C157 40 118 68 118 143C118 202 143 228 167 228C202 228 196 174 239 174C259 174 282 185 282 214C282 251 244 267 194 267C108 267 25 221 25 127C25 29 117 -12 229 -12C375 -12 531 57 531 216C531 336 443 367 365 410C301 445 275 473 275 520C275 576 311 625 389 625C440 625 472 604 472 563C472 519 436 506 385 504Z"/></g>`;

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
  // The bundled font has no emoji or mathematical-script glyphs; avoid tofu boxes.
  const source = String(value ?? "")
    .normalize("NFKC")
    .replace(/\p{Extended_Pictographic}|[\u200d\ufe0e\ufe0f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
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
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}/${part("month")}/${part("day")} (${part("weekday").replace("週", "")}) ${part("dayPeriod")} ${part("hour")}:${part("minute")}`;
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

function receiptSvg({ kind, payer, recipient, details, items, amount, currency = "TWD", payment, time }) {
  if (!["order", "tip"].includes(kind)) throw new Error("收據類型無效");
  const isTip = kind === "tip";
  const label = isTip ? "打賞" : "訂單";
  const recipients = String(recipient || "待選陪陪").split("、").filter(Boolean);
  const lines = Array.isArray(items) && items.length
    ? items.slice(0, 30)
    : [{ to: recipients[0], name: details || (isTip ? "打賞" : "陪玩訂單"), quantity: 1, amount }];
  const safeMoney = money(amount, currency);
  const paymentText = payment && payment !== "已確認付款"
    ? `${label}已使用${payment}付款`
    : `${label}已付款`;
  const status = wrapText(paymentText, 26, 1)[0];
  const statusFont = Math.max(12, Math.min(17, Math.floor(385 / textUnits(status))));
  const statusLeft = Math.max(43, (PAPER_WIDTH - (26 + textUnits(status) * statusFont)) / 2);
  let recipientY = 350;
  const recipientRows = recipients.slice(0, 12).map((name, index) => {
    const row = `<text x="35" y="${recipientY}" class="muted">${String(index + 1).padStart(2, "0")}</text><text x="65" y="${recipientY}" class="bold">${escapeXml(wrapText(name, 20, 1)[0])}</text>`;
    recipientY += 32;
    return row;
  });
  if (recipients.length > 12) {
    recipientRows.push(`<text x="35" y="${recipientY}" class="muted">另有 ${recipients.length - 12} 位陪陪</text>`);
    recipientY += 32;
  }
  const dividerY = recipientY + 14;
  const detailLabelY = dividerY + 39;
  let itemY = detailLabelY + 37;
  let previousStaff = null;
  const itemRows = lines.map((item) => {
    const staff = wrapText(item.to || recipients[0] || "陪陪", 30, 1)[0];
    let row = "";
    if (staff !== previousStaff) {
      if (previousStaff !== null) itemY += 12;
      row += `<text x="35" y="${itemY}" class="muted">${escapeXml(staff)}</text>`;
      itemY += 27;
      previousStaff = staff;
    }
    const itemName = wrapText(item.name || details || label, 14, 2);
    const quantity = Math.max(1, Number(item.quantity || 1));
    const subtotal = Number(item.amount ?? 0);
    const amountText = Number.isFinite(subtotal) && subtotal >= 0
      ? (isTip ? `${Math.round(subtotal).toLocaleString("zh-TW")} ASD` : money(subtotal, currency))
      : "—";
    itemName.forEach((name, index) => {
      const last = index === itemName.length - 1;
      const baseline = itemY + index * 27;
      if (last && textUnits(name) < 11) {
        row += `<path d="M${Math.max(165, 35 + textUnits(name) * 18 + 40)} ${baseline - 4} H${Math.max(365, 465 - textUnits(amountText) * 10 - 15)}" stroke="#c8bda9" stroke-dasharray="2 3"/>`;
      }
      row += `<text x="35" y="${baseline}" class="item">${escapeXml(name)}${last ? `<tspan class="muted"> ×${quantity}</tspan>` : ""}</text>`;
      if (last) row += `<text x="465" y="${baseline}" class="price" style="font-size:${amountText.length > 11 ? 14 : 18}px" text-anchor="end">${escapeXml(amountText)}</text>`;
    });
    itemY += itemName.length * 28;
    return row;
  }).join("");
  const summaryY = Math.max(itemY + 32, 590);
  const height = summaryY + 199;
  const topTeeth = Array.from({ length: 51 }, (_, index) => `${index * 10},${index % 2 ? 0 : 8}`).join(" ");
  const bottomTeeth = Array.from({ length: 51 }, (_, index) => `${PAPER_WIDTH - index * 10},${index % 2 ? height : height - 8}`).join(" ");
  const totalFont = safeMoney.length > 11 ? 31 : 40;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAPER_WIDTH}" height="${height}" viewBox="0 0 ${PAPER_WIDTH} ${height}">
    <defs><linearGradient id="paper" x2="0" y2="1"><stop stop-color="#fcfaf5"/><stop offset="1" stop-color="#f4efe2"/></linearGradient></defs>
    <style>text{font-family:'Noto Sans CJK TC',sans-serif}.muted{fill:#817a70;font-size:15px}.bold{fill:#292621;font-size:18px;font-weight:700}.item{fill:#292621;font-size:17px;font-weight:700}.price{fill:#292621;font-size:18px;font-weight:700}</style>
    <polygon points="${topTeeth} ${bottomTeeth}" fill="url(#paper)"/>
    ${AS_MARK}
    <text x="250" y="124" text-anchor="middle" font-size="24" font-weight="700" letter-spacing="7">${label}收據</text>
    <text x="250" y="151" text-anchor="middle" fill="#827567" font-size="12" letter-spacing="6">${isTip ? "TIP RECEIPT" : "ORDER RECEIPT"}</text>
    <g transform="rotate(-14 410 100)"><circle cx="410" cy="100" r="45" fill="none" stroke="#c53228" stroke-width="1.5"/><circle cx="410" cy="100" r="41" fill="none" stroke="#c53228" stroke-width="1.5"/><text x="410" y="99" text-anchor="middle" fill="#c53228" font-size="21">已付款</text><text x="410" y="120" text-anchor="middle" fill="#c53228" font-size="12" letter-spacing="2">PAID</text></g>
    <rect x="35" y="177" width="430" height="44" rx="6" fill="none" stroke="#c53228" stroke-width="1.5"/>
    <circle cx="${statusLeft + 9}" cy="199" r="11" fill="#c53228"/><text x="${statusLeft + 9}" y="205" fill="#fff" text-anchor="middle" font-size="15">✓</text>
    <text x="${statusLeft + 27}" y="206" fill="#b62720" font-size="${statusFont}" font-weight="700">${escapeXml(status)}</text>
    <path d="M35 244 H465" stroke="#c6bca9" stroke-dasharray="5 4"/>
    <text x="35" y="286" class="muted">${isTip ? "打賞人" : "闆闆"}</text>
    <text x="465" y="286" class="bold" text-anchor="end">${escapeXml(wrapText(payer || "闆闆", 21, 1)[0])}</text>
    <text x="35" y="321" class="muted">${isTip ? "受賞陪陪" : "接單陪陪"}</text>
    ${recipientRows.join("")}
    <path d="M35 ${dividerY} H465" stroke="#c6bca9" stroke-dasharray="5 4"/>
    <text x="35" y="${detailLabelY}" class="muted">${isTip ? "打賞明細" : "訂單明細"}</text>
    ${itemRows}
    <path d="M35 ${summaryY} H465" stroke="#292621" stroke-width="3"/>
    <path d="M35 ${summaryY + 4} H465" stroke="#292621" stroke-width="1"/>
    <text x="35" y="${summaryY + 70}" font-size="18" letter-spacing="5">總金額</text>
    <text x="465" y="${summaryY + 72}" text-anchor="end" font-size="${totalFont}" font-weight="700">${escapeXml(safeMoney)}</text>
    <path d="M35 ${summaryY + 101} H465" stroke="#c6bca9" stroke-dasharray="5 4"/>
    <text x="250" y="${summaryY + 145}" text-anchor="middle" font-size="15">${escapeXml(taipeiTime(time))}</text>
    <text x="250" y="${summaryY + 174}" text-anchor="middle" fill="#827567" font-size="16" letter-spacing="4">感謝您的支持</text>
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
