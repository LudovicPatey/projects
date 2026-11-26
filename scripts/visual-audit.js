// Finds layout defects on the page it runs in. Paste it in the browser console, or run it from a test browser:
// it returns a list of problems, empty when the page looks right. See AGENTS.md, "Visual check".
(() => {
  const problems = [];
  const vw = document.documentElement.clientWidth;
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const name = (el) => {
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''} "${label}"`;
  };
  // The page itself never scrolls sideways.
  if (document.documentElement.scrollWidth > vw + 1) problems.push(`page is ${document.documentElement.scrollWidth}px wide for a ${vw}px window`);
  // Text squeezed into a column so narrow that words break letter by letter.
  for (const el of document.querySelectorAll('h1, h2, h3, b, strong, p, span, a, button, label, dd, dt, small, li')) {
    if (!visible(el) || el.closest('.sr-only, svg, .katex')) continue;
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (text.length < 6) continue;
    const cs = getComputedStyle(el); const fs = parseFloat(cs.fontSize); const r = el.getBoundingClientRect();
    if (r.width < fs * 3 && r.height > fs * 2.5) problems.push(`squeezed text: ${name(el)} is ${Math.round(r.width)}px wide and ${Math.round(r.height)}px tall`);
  }
  // Controls that leave the window.
  for (const el of document.querySelectorAll('button, a.btn, input, select, textarea')) {
    if (!visible(el) || el.closest('[aria-hidden="true"]')) continue;
    const r = el.getBoundingClientRect();
    let clipped = false; for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') { clipped = true; break; } }
    if (!clipped && (r.right > vw + 1 || r.left < -1)) problems.push(`off screen: ${name(el)} spans ${Math.round(r.left)}–${Math.round(r.right)}px`);
    // A control that spills out of its column or of a container hiding its overflow: a header too narrow for its buttons.
    // The next column then covers it, or it is cut.
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      const column = p.parentElement && getComputedStyle(p.parentElement).display.includes('grid');
      if (o === 'visible' && !column) continue;
      if (o === 'visible' || o === 'hidden' || o === 'clip') { const c = p.getBoundingClientRect(); if (r.right > c.right + 1 || r.left < c.left - 1) problems.push(`cut by its container: ${name(el)}`); }
      break;
    }
  }
  // Dropdowns: one style, room for the arrow, text not cut, same height as the controls beside them.
  for (const s of document.querySelectorAll('select')) {
    if (!visible(s)) continue;
    const cs = getComputedStyle(s); const r = s.getBoundingClientRect();
    if (cs.appearance !== 'none') problems.push(`native dropdown: ${name(s)}`);
    if (!cs.backgroundImage.includes('svg')) problems.push(`dropdown without its arrow: ${name(s)}`);
    if (parseFloat(cs.paddingRight) < 20) problems.push(`dropdown text can run under its arrow: ${name(s)} (padding-right ${cs.paddingRight})`);
    const opt = s.options[s.selectedIndex];
    if (opt) {
      const probe = document.createElement('span'); probe.textContent = opt.text; probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font};letter-spacing:${cs.letterSpacing}`;
      document.body.appendChild(probe); const need = probe.getBoundingClientRect().width; probe.remove();
      const room = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
      if (need > room + 1 && r.width < 160) problems.push(`dropdown cuts "${opt.text}": ${name(s)} (${Math.round(room)}px for ${Math.round(need)}px)`);
    }
    for (const sib of s.parentElement.children) {
      if (sib === s || !visible(sib) || !sib.matches('button.btn, a.btn, input:not([type=checkbox]):not([type=radio]), select')) continue;
      const q = sib.getBoundingClientRect();
      const sameRow = Math.abs((q.top + q.bottom) / 2 - (r.top + r.bottom) / 2) < Math.max(q.height, r.height) / 2;
      if (sameRow && Math.abs(q.height - r.height) > 4) problems.push(`uneven row: ${name(s)} is ${Math.round(r.height)}px tall beside ${name(sib)} at ${Math.round(q.height)}px`);
    }
  }
  // Menus and popovers that open outside the window.
  for (const m of document.querySelectorAll('.mention-menu, .dep-menu, .modal, [role="menu"], [role="listbox"], [role="dialog"]')) {
    if (!visible(m)) continue;
    const r = m.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) problems.push(`menu outside the window: ${name(m)}`);
  }
  // Mathematics: what KaTeX could not read, a dollar left in the text, and words set as one formula in italics.
  const source = (k) => (k.querySelector('annotation')?.textContent || k.getAttribute('title') || k.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  for (const k of document.querySelectorAll('.katex-error')) if (visible(k)) problems.push(`formula KaTeX cannot read: "${source(k)}"`);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !/\$[\\A-Za-z{(]|[A-Za-z})]\$/.test(n.textContent)) continue;
    if (el.closest('code, pre, kbd, textarea, input, script, style, .katex, [contenteditable="true"], .sr-only') || !visible(el)) continue;
    problems.push(`dollar left in the text: ${name(el)} "${n.textContent.trim().slice(0, 60)}"`);
  }
  // KaTeX sets each italic letter in its own span: four or more in a row are a word written as a formula, "effectively" in italics.
  for (const k of document.querySelectorAll('.katex-html')) {
    if (!visible(k)) continue;
    let run = 0; let worst = 0;
    for (const s of k.querySelectorAll('span')) {
      const letter = s.classList.contains('mord') && s.classList.contains('mathnormal') && /^[A-Za-z]$/.test(s.textContent);
      if (!letter) { if (s.children.length === 0 && s.textContent.trim()) run = 0; continue; }
      run = s.previousElementSibling && s.previousElementSibling.classList.contains('mathnormal') ? run + 1 : 1;
      worst = Math.max(worst, run);
    }
    if (worst >= 4) problems.push(`words set as a formula in italics: "${source(k.closest('.katex') || k)}"`);
  }
  return [...new Set(problems)];
})();
