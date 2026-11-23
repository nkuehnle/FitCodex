import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, type Phase } from "../api";
import { usePrefs } from "../App";
import { RangePicker, presetRange, today, type Range } from "../charts/RangePicker";
import { IS_ANDROID, saveOrShareText } from "../platform";
import { SECTION_TEXT, buildReport, bytesToBase64, type ReportSection } from "../report/pdf";

const ALL_SECTIONS = Object.keys(SECTION_TEXT) as ReportSection[];

/** A 2–3 page PDF for a time range or a phase, made on the device. */
export function PdfReportCard() {
  const { unit } = usePrefs();
  const [phases, setPhases] = useState<Phase[]>([]);
  const [range, setRange] = useState<Range>(() => presetRange("3m"));
  const [sections, setSections] = useState<ReportSection[]>(ALL_SECTIONS);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.listPhases().then(setPhases);
  }, []);
  const toggle = (s: ReportSection, on: boolean) => setSections(ALL_SECTIONS.filter((x) => (x === s ? on : sections.includes(x))));
  async function run(toDownloads: boolean) {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const { bytes, pages } = await buildReport(range, sections, unit);
      const name = `fitcodex-report-${today()}`;
      const what = `${pages} page${pages === 1 ? "" : "s"}`;
      if (IS_ANDROID) {
        const saved = await api.sharePdf(name, bytesToBase64(bytes), toDownloads);
        setMsg(saved ? `Saved ${saved} (${what}).` : `Report ready (${what}).`);
      } else {
        const path = await save({ defaultPath: `${name}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
        if (path) {
          await api.saveBase64(path, bytesToBase64(bytes));
          setMsg(`Saved ${path} (${what}).`);
        }
      }
    } catch (e) {
      setError(`Couldn't make the report: ${e}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2 className="section-title">PDF report</h2>
      <p className="muted small">
        Two or three pages of charts and tables for a time span, a routine or a goal phase. A goal phase is compared with the phases just
        before it.
      </p>
      <RangePicker value={range} onChange={setRange} phases={phases} presets={["4w", "3m", "6m", "1y", "all"]} />
      {ALL_SECTIONS.map((s) => (
        <label key={s} className="check small">
          <input type="checkbox" checked={sections.includes(s)} onChange={(e) => toggle(s, e.target.checked)} />
          {SECTION_TEXT[s]}
        </label>
      ))}
      <div className="row">
        <button className="button primary" disabled={busy || !sections.length} onClick={() => run(false)}>
          {busy ? "Making report…" : IS_ANDROID ? "Share PDF" : "Save PDF"}
        </button>
        {IS_ANDROID && (
          <button className="button" disabled={busy || !sections.length} onClick={() => run(true)}>
            Save to Downloads
          </button>
        )}
      </div>
      {msg && <p className="success small">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

const WEEKS = [4, 8, 12];

/** A written progress report to share or copy. */
export function ReportCard() {
  const [weeks, setWeeks] = useState(8);
  const [body, setBody] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: (report: string) => Promise<string | null>) => {
    setMsg(null);
    setError(null);
    try {
      setMsg(await f(await api.progressReport(weeks, body)));
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <section className="card">
      <h2 className="section-title">Progress report</h2>
      <p className="muted small">
        FitCodex never sends anything by itself. The report goes only where you send it, and includes health data if you leave that box
        ticked.
      </p>
      <div className="segmented">
        {WEEKS.map((w) => (
          <button key={w} className={weeks === w ? "active" : ""} onClick={() => setWeeks(w)}>
            {w} weeks
          </button>
        ))}
      </div>
      <label className="check small">
        <input type="checkbox" checked={body} onChange={(e) => setBody(e.target.checked)} />
        Include weight, measurements, nutrition and recovery
      </label>
      <div className="row">
        <button
          className="button primary"
          onClick={() =>
            run(async (report) => {
              const saved = await saveOrShareText(`fitcodex-report-${today()}.md`, "text/plain", report);
              return saved && `Saved ${saved}`;
            })
          }
        >
          Share report
        </button>
        <button
          className="button"
          onClick={() =>
            run(async (report) => {
              await api.copyText(report);
              return "Report copied.";
            })
          }
        >
          Copy report
        </button>
      </div>
      {msg && <p className="success small">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
