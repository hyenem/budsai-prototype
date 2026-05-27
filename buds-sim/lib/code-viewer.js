// Inline code viewer that highlights the line currently executing.
//
// The viewer is fed pre-tokenized snippets (so we don't ship a
// syntax-highlighter library). Each snippet has named "anchors" that
// the simulator can `fire(anchorName)` to flash.
//
// Usage:
//   const viewer = new CodeViewer(rootEl, snippets);
//   viewer.fire("ringbuffer", "snapshot");

const KW = new Set([
  "function","const","let","var","return","if","else","for","while","await",
  "async","import","from","export","new","class","this","try","catch","throw",
  "typeof","of","in",
]);

function tokenize(line) {
  // Very small JS tokenizer — good enough to color what we ship.
  const out = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "/" && line[i + 1] === "/") {
      out.push({ t: "com", v: line.slice(i) });
      i = line.length;
      break;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; let j = i + 1;
      while (j < line.length && line[j] !== q) {
        if (line[j] === "\\") j++;
        j++;
      }
      out.push({ t: "str", v: line.slice(i, j + 1) });
      i = j + 1; continue;
    }
    if (/[a-zA-Z_$]/.test(c)) {
      let j = i + 1;
      while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      if (KW.has(word)) out.push({ t: "kw", v: word });
      else if (line[j] === "(") out.push({ t: "fn", v: word });
      else out.push({ t: null, v: word });
      i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < line.length && /[0-9_.]/.test(line[j])) j++;
      out.push({ t: "num", v: line.slice(i, j) });
      i = j; continue;
    }
    out.push({ t: null, v: c });
    i++;
  }
  return out;
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderLine(text) {
  return tokenize(text).map(tok =>
    tok.t ? `<span class="${tok.t}">${esc(tok.v)}</span>` : esc(tok.v)
  ).join("");
}

export class CodeViewer {
  /**
   * @param {HTMLElement} root
   * @param {Record<string, {title:string, lines:string[], anchors:Record<string,number>}>} snippets
   */
  constructor(root, snippets) {
    this.root = root;
    this.snippets = snippets;
    this.activeTab = Object.keys(snippets)[0];
    this._lineEls = {};   // tab -> HTMLElement[]
    this._tabBtns = {};   // tab -> HTMLElement
    this._render();
  }

  _render() {
    const tabs = Object.entries(this.snippets).map(([id, snip]) => {
      const cls = id === this.activeTab ? "is-active" : "";
      return `<button class="code-tab ${cls}" data-tab="${id}">${esc(snip.title)}</button>`;
    }).join("");

    const panes = Object.entries(this.snippets).map(([id, snip]) => {
      const cls = id === this.activeTab ? "is-active" : "";
      const lines = snip.lines.map((line, idx) =>
        `<div class="code-line" data-line="${idx}">` +
          `<span class="lineno">${idx + 1}</span>` +
          `<span class="text">${renderLine(line) || "&nbsp;"}</span>` +
        `</div>`
      ).join("");
      return `<div class="code-pane ${cls}" data-pane="${id}">${lines}</div>`;
    }).join("");

    this.root.innerHTML = `
      <div class="code-tabs">${tabs}</div>
      <div class="code-body">${panes}</div>
    `;

    // Cache refs
    for (const id of Object.keys(this.snippets)) {
      this._lineEls[id] = Array.from(
        this.root.querySelectorAll(`[data-pane="${id}"] .code-line`)
      );
      this._tabBtns[id] = this.root.querySelector(`[data-tab="${id}"]`);
    }

    this.root.querySelectorAll(".code-tab").forEach(b => {
      b.addEventListener("click", () => this.selectTab(b.dataset.tab));
    });
  }

  selectTab(id) {
    if (!(id in this.snippets)) return;
    this.activeTab = id;
    this.root.querySelectorAll(".code-tab").forEach(b => {
      b.classList.toggle("is-active", b.dataset.tab === id);
    });
    this.root.querySelectorAll(".code-pane").forEach(p => {
      p.classList.toggle("is-active", p.dataset.pane === id);
    });
  }

  /** Flash a line — switches tab to that snippet and highlights briefly. */
  fire(tab, anchor) {
    const snip = this.snippets[tab];
    if (!snip) return;
    const lineIdx = snip.anchors?.[anchor];
    if (lineIdx == null) return;

    this.selectTab(tab);
    const el = this._lineEls[tab]?.[lineIdx];
    if (!el) return;

    // Flash tab too
    const tabBtn = this._tabBtns[tab];
    tabBtn?.classList.add("is-firing");
    setTimeout(() => tabBtn?.classList.remove("is-firing"), 700);

    // Demote any earlier active line in this pane
    this._lineEls[tab].forEach(l => {
      if (l.classList.contains("is-active")) {
        l.classList.remove("is-active");
        l.classList.add("was-active");
      }
    });
    el.classList.add("is-active");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}
