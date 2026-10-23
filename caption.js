/*
 * Builds the Discord message text that goes with a shrunk video. Pure functions (no DOM) so they can be
 * unit-tested in Node. Everything the user types is escaped so it can't turn into formatting or pings.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DRCaption = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_LEN = 2000; // Discord's message limit
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** Make user text safe: no markdown, no mentions, no line breaks, bounded length. */
  function clean(text, max = 200) {
    return String(text || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, max)
      .replace(/[\\*_~`|>[\]]/g, '\\$&')
      .replace(/</g, '\\<')
      .replace(/@/g, '@​');
  }

  /** '2026-10-12' -> 'Oct 12, 2026'. Returns '' for anything that is not a real date. */
  function formatDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return '';
    return `${MONTHS[mo - 1]} ${d}, ${y}`;
  }

  /** A Date (or ms timestamp) -> 'YYYY-MM-DD' in local time, or '' if it is missing or implausible. */
  function toISODate(value, now = Date.now()) {
    const t = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1) || t > now + 864e5) return '';
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** Best guess at when a video was recorded: the file's own metadata date, else its last-modified time. */
  function recordedDate(tagDate, lastModified, now = Date.now()) {
    return toISODate(tagDate, now) || toISODate(lastModified, now);
  }

  /**
   * opts: { event, venue, dateISO, note, durationText, part: {index, count} | null }
   * Example:  🎤 **Artist** · Venue
   *           📅 Oct 12, 2026 · ⏱ 0:45 · part 1/3
   *           note
   */
  function build(opts) {
    const event = clean(opts.event, 100);
    const venue = clean(opts.venue, 100);
    const head = event ? `🎤 **${event}**${venue ? ' · ' + venue : ''}` : venue ? `🎬 ${venue}` : '🎬 New clip';
    const meta = [];
    const date = formatDate(opts.dateISO);
    if (date) meta.push(`📅 ${date}`);
    if (opts.durationText) meta.push(`⏱ ${opts.durationText}`);
    if (opts.part && opts.part.count > 1) meta.push(`part ${opts.part.index}/${opts.part.count}`);
    const lines = [head];
    if (meta.length) lines.push(meta.join(' · '));
    const note = clean(opts.note, 500);
    if (note) lines.push(note);
    return lines.join('\n').slice(0, MAX_LEN);
  }

  return { clean, formatDate, toISODate, recordedDate, build, MAX_LEN };
});
