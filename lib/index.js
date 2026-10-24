import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
/**
* Walk bytes from `from`, collecting every COMPLETE zstd frame.
* Returns the frames plus `next`: the offset to resume from — the end of
* the last complete frame, or `from` itself when nothing completed (a
* partial frame at the tail simply waits for more bytes).
*/
function scanZstdFrames(buf, from) {
	const frames = [];
	let pos = Math.max(0, from);
	while (pos + 4 <= buf.length) {
		if (buf.readUInt32LE(pos) !== 4247762216) {
			pos += 1;
			continue;
		}
		const end = walkZstdFrame(buf, pos);
		if (end === null) {
			if (pos > buf.length - (1 << 20)) break;
			pos += 4;
			continue;
		}
		frames.push({
			start: pos,
			end
		});
		pos = end;
	}
	return {
		frames,
		next: frames.length > 0 ? frames[frames.length - 1].end : from
	};
}
/** Frame header + block walk; end offset, or null when bytes run out. */
function walkZstdFrame(buf, start) {
	let offset = start + 4;
	if (offset >= buf.length) return null;
	const descriptor = buf.readUInt8(offset);
	offset += 1;
	const contentSizeFlag = descriptor >>> 6;
	const singleSegment = (descriptor & 32) !== 0;
	const checksum = (descriptor & 4) !== 0;
	const dictionaryFlag = descriptor & 3;
	const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
	const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
	const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
	if (buf.length - offset < remainingHeaderBytes) return null;
	offset += remainingHeaderBytes;
	for (;;) {
		if (buf.length - offset < 3) return null;
		const blockHeader = buf.readUIntLE(offset, 3);
		offset += 3;
		const lastBlock = (blockHeader & 1) !== 0;
		const blockType = blockHeader >>> 1 & 3;
		const blockSize = blockHeader >>> 3;
		if (buf.length - offset < (blockType === 1 ? 1 : blockSize)) return null;
		offset += blockType === 1 ? 1 : blockSize;
		if (lastBlock) break;
	}
	if (checksum) {
		if (buf.length - offset < 4) return null;
		offset += 4;
	}
	return offset;
}
/** Decompress every complete frame and return the concatenated text. */
function framesToText(buf, frames) {
	const parts = [];
	for (const f of frames) try {
		parts.push(zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8"));
	} catch {}
	return parts.join("\n");
}
/**
* Pull compaction events out of a chunk of session-log jsonl, in order.
* One chunk may span several compaction cycles, so the caller replays the
* list rather than squashing it.
*/
function parseCompactionEvents(text) {
	const out = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let ev;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		const id = typeof ev.data?.compactionId === "string" ? ev.data.compactionId : null;
		if (ev.type === "compaction/start" && typeof ev.time === "number") out.push({
			kind: "start",
			id,
			time: ev.time
		});
		else if (ev.type === "compaction/end") out.push({
			kind: "end",
			id,
			time: null
		});
	}
	return out;
}
/**
* The most recently written session.v4.jsonl.zstd under the sessions dir
* (sessions/<project>/session-<id>/session.v4.jsonl.zstd), or null.
*/
function findNewestSessionLog(sessionsDir) {
	let projects;
	try {
		projects = readdirSync(sessionsDir);
	} catch {
		return null;
	}
	let newest = null;
	for (const project of projects) {
		let sessions;
		try {
			sessions = readdirSync(path.join(sessionsDir, project));
		} catch {
			continue;
		}
		for (const session of sessions) {
			const file = path.join(sessionsDir, project, session, "session.v4.jsonl.zstd");
			try {
				const st = statSync(file);
				if (!newest || st.mtimeMs > newest.mtime) newest = {
					file,
					mtime: st.mtimeMs
				};
			} catch {}
		}
	}
	return newest?.file ?? null;
}
//#endregion
//#region src/index.ts
/**
* Host half of @martin/dsh-model-dial.
*
* Publishes one `modelDial.status` Remote (no arguments) that returns the
* live state of the local llama-server:
*   - GET /slots on 127.0.0.1:8080  -> phase, task id, context size, decoded count
*   - tail of the server's log file -> prefill progress %, prompt t/s, decode t/s
*
* The dial is decorative: nothing here may ever throw out of the poll loop,
* and a dead server simply reports phase "down".
*/
const PORT = Number(process.env.DSH_DIAL_PORT ?? 8080);
const LOG_DIR = process.env.DSH_DIAL_LOG_DIR ?? "C:/Users/press/OneDrive/Projects/TurboQuantLlamaCppSetup/logs";
const SESSIONS_DIR = process.env.DSH_DIAL_SESSIONS_DIR ?? path.join(os.homedir(), ".dsh", "sessions");
const SLOTS_URL = `http://127.0.0.1:${PORT}/slots`;
const POLL_MS = 750;
const STALE_MS = 4e3;
/** A compaction without its end event is dropped after this long. */
const COMPACT_TTL_MS = 9e5;
/** Trailing window replayed when attaching to a (new) session log. */
const REPLAY_BYTES = 1 << 20;
const REMOTE_METHODS_KEY = "@deepseek-ai/dsh-typert-protocol/remote-methods";
const IDLE = {
	task: null,
	contextTokens: null,
	prefilled: null,
	prefillTotal: null,
	prefillPercent: null,
	prefillTps: null,
	progressAt: null,
	decoded: null,
	decodeTps: null,
	compacting: false,
	compactPercent: null
};
var ModelDialController = class {
	typertRemote = Object.freeze({
		service: this,
		serviceKey: "modelDialController",
		namespace: "modelDial"
	});
	state = {
		phase: "idle",
		at: 0,
		...IDLE
	};
	ticking = false;
	slotsAt = 0;
	logFile = null;
	logOffset = 0;
	tail = "";
	prefillLine = null;
	decodeLine = null;
	timer = null;
	sessionFile = null;
	sessionOffset = 0;
	compactingId = null;
	compactingSince = null;
	/**
	* Last summary percent of the running compaction, held across the brief
	* slot-idle tail between the last token and the compaction/end event.
	*/
	lastCompactPercent = null;
	constructor() {
		this.timer = setInterval(() => {
			this.tick().catch(() => {});
		}, POLL_MS);
		this.timer.unref?.();
	}
	/** Latest frozen snapshot, for the Remote. */
	status() {
		return this.state;
	}
	async tick() {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const slot = await this.fetchSlot();
			this.scanLog();
			this.scanSessionLog();
			this.synthesize(slot);
		} finally {
			this.ticking = false;
		}
	}
	async fetchSlot() {
		try {
			const res = await fetch(SLOTS_URL, { signal: AbortSignal.timeout(2500) });
			if (!res.ok) return null;
			const body = await res.json();
			const slot = Array.isArray(body) ? body[0] : body;
			if (!slot || typeof slot !== "object") return null;
			this.slotsAt = Date.now();
			return slot;
		} catch {
			return null;
		}
	}
	/** Read newly appended bytes from the newest llama-server log (UTF-16LE). */
	scanLog() {
		let names;
		try {
			names = readdirSync(LOG_DIR);
		} catch {
			return;
		}
		const candidates = names.filter((n) => n.startsWith("llama-server-") && n.endsWith(".log")).sort();
		const name = candidates[candidates.length - 1];
		if (!name) return;
		const file = path.join(LOG_DIR, name);
		let size;
		try {
			size = statSync(file).size;
		} catch {
			return;
		}
		if (size % 2 !== 0) return;
		if (this.logFile !== file) {
			this.logFile = file;
			this.logOffset = 0;
			this.tail = "";
		}
		if (size < this.logOffset) {
			this.logOffset = 0;
			this.tail = "";
		}
		if (size <= this.logOffset) return;
		let fd;
		try {
			fd = openSync(file, "r");
		} catch {
			return;
		}
		try {
			const len = Math.min(size - this.logOffset, 1 << 20);
			const buf = Buffer.alloc(len);
			const read = readSync(fd, buf, 0, len, this.logOffset);
			this.logOffset += read;
			this.tail += buf.subarray(0, read).toString("utf16le");
		} catch {
			return;
		} finally {
			closeSync(fd);
		}
		let nl;
		while ((nl = this.tail.indexOf("\n")) !== -1) {
			const line = this.tail.slice(0, nl);
			this.tail = this.tail.slice(nl + 1);
			this.parseLine(line);
		}
		if (this.tail.length > 65536) this.tail = this.tail.slice(-8192);
	}
	/**
	* Tail newly appended zstd frames of the active session log and track
	* prompt compaction: compaction/start … compaction/end bracket a few
	* minutes of model time summarising the old context.
	*/
	scanSessionLog() {
		const file = findNewestSessionLog(SESSIONS_DIR);
		if (!file) return;
		if (this.sessionFile !== file) {
			this.sessionFile = file;
			this.sessionOffset = -1;
		}
		let size;
		try {
			size = statSync(file).size;
		} catch {
			return;
		}
		if (this.sessionOffset < 0) {
			this.sessionOffset = size;
			this.replayTail(file, size);
			return;
		}
		if (size < this.sessionOffset) {
			this.sessionOffset = size;
			return;
		}
		if (size === this.sessionOffset) return;
		let fd;
		try {
			fd = openSync(file, "r");
		} catch {
			return;
		}
		try {
			const len = Math.min(size - this.sessionOffset, 1 << 20);
			const buf = Buffer.alloc(len);
			const read = readSync(fd, buf, 0, len, this.sessionOffset);
			const chunk = buf.subarray(0, read);
			const { frames, next } = scanZstdFrames(chunk, 0);
			if (frames.length > 0) for (const e of parseCompactionEvents(framesToText(chunk, frames))) this.applyCompactionEvent(e);
			this.sessionOffset += next;
		} catch {} finally {
			closeSync(fd);
		}
	}
	/** Feed one compaction event into the start/end state machine. */
	applyCompactionEvent(e) {
		if (e.kind === "start") {
			this.compactingId = e.id;
			this.compactingSince = e.time;
		} else if (this.compactingId === null || e.id === null || this.compactingId === e.id) {
			this.compactingId = null;
			this.compactingSince = null;
		}
	}
	/**
	* Re-read the trailing window of a freshly attached session log and
	* replay its compaction events, so a compaction that began (or is in
	* flight) before the attach still lights the dial.
	*/
	replayTail(file, size) {
		if (size === 0) return;
		const from = Math.max(0, size - REPLAY_BYTES);
		let fd;
		try {
			fd = openSync(file, "r");
		} catch {
			return;
		}
		try {
			const buf = Buffer.alloc(size - from);
			readSync(fd, buf, 0, size - from, from);
			const { frames } = scanZstdFrames(buf, 0);
			if (frames.length > 0) for (const e of parseCompactionEvents(framesToText(buf, frames))) this.applyCompactionEvent(e);
		} catch {} finally {
			closeSync(fd);
		}
	}
	/** True while a compaction from the session log is still running. */
	isCompacting() {
		if (this.compactingSince === null) return false;
		if (Date.now() - this.compactingSince > COMPACT_TTL_MS) {
			this.compactingSince = null;
			return false;
		}
		return true;
	}
	parseLine(line) {
		const now = Date.now();
		let m = line.match(/\|\s*task\s+(\d+)\s*\|\s*prompt processing, n_tokens =\s*(\d+), progress = ([\d.]+), t =\s*[\d.]+ s \/ ([\d.]+) tokens per second/);
		if (m) {
			this.prefillLine = {
				task: Number(m[1]),
				tokens: Number(m[2]),
				percent: Math.min(1, Number(m[3])),
				tps: Number(m[4]),
				at: now
			};
			return;
		}
		m = line.match(/\|\s*task\s+(\d+)\s*\|\s*n_decoded =\s*(\d+), tg =\s*[\d.]+ t\/s, tg_3s =\s*([\d.]+) t\/s/);
		if (m) this.decodeLine = {
			task: Number(m[1]),
			decoded: Number(m[2]),
			tg3: Number(m[3]),
			at: now
		};
	}
	freshPrefill(task) {
		const l = this.prefillLine;
		if (!l || Date.now() - l.at > 3e4) return null;
		if (task !== null && l.task !== task) return null;
		return l;
	}
	freshDecode(task) {
		const l = this.decodeLine;
		if (!l || Date.now() - l.at > 2e4) return null;
		if (task !== null && l.task !== task) return null;
		return l;
	}
	/**
	* Summary progress of the running compaction, 0..1: generated tokens over
	* the summarisation budget. The compaction is a single request on the
	* slot, and while it runs the slot reports the request's own cap
	* (params.max_tokens) and the live n_decoded — that ratio is the percent.
	* Held in lastCompactPercent across the slot-idle tail (last token ->
	* compaction/end event); null when unknown so the dial can spin.
	*/
	compactPercentFor(slot, compacting) {
		if (!compacting) {
			this.lastCompactPercent = null;
			return null;
		}
		if (slot !== null && slot.is_processing === true) {
			const nextToken = slot.next_token?.[0];
			const decoded = typeof nextToken?.n_decoded === "number" ? nextToken.n_decoded : null;
			const params = slot.params;
			const cap = typeof params?.max_tokens === "number" ? params.max_tokens : typeof params?.n_predict === "number" ? params.n_predict : null;
			if (decoded !== null && typeof cap === "number" && cap > 0) this.lastCompactPercent = Math.min(1, Math.max(0, decoded / cap));
		}
		return this.lastCompactPercent;
	}
	synthesize(slot) {
		const now = Date.now();
		const compacting = this.isCompacting();
		const compactPercent = this.compactPercentFor(slot, compacting);
		const stale = !slot || now - this.slotsAt > STALE_MS;
		const s = slot ?? {};
		const task = typeof s.id_task === "number" ? s.id_task : null;
		const contextTokens = typeof s.n_prompt_tokens === "number" ? s.n_prompt_tokens : null;
		if (stale) {
			this.state = {
				phase: "down",
				at: now,
				...IDLE,
				compacting
			};
			return;
		}
		const nextToken = s.next_token?.[0];
		const decoded = typeof nextToken?.n_decoded === "number" ? nextToken.n_decoded : 0;
		const processed = typeof s.n_prompt_tokens_processed === "number" ? s.n_prompt_tokens_processed : null;
		if (s.is_processing !== true) {
			this.state = {
				phase: "idle",
				at: now,
				...IDLE,
				contextTokens,
				compacting,
				compactPercent
			};
			return;
		}
		if (decoded > 0) {
			const dl = this.freshDecode(task);
			this.state = {
				phase: "decode",
				at: now,
				task,
				contextTokens,
				prefilled: processed,
				prefillTotal: null,
				prefillPercent: null,
				prefillTps: null,
				progressAt: null,
				decoded,
				decodeTps: dl?.tg3 ?? null,
				compacting,
				compactPercent
			};
			return;
		}
		const pl = this.freshPrefill(task);
		this.state = {
			phase: "prefill",
			at: now,
			task,
			contextTokens,
			prefilled: pl ? pl.tokens : processed,
			prefillTotal: pl && pl.percent > 0 ? Math.round(pl.tokens / pl.percent) : null,
			prefillPercent: pl ? pl.percent : null,
			prefillTps: pl ? pl.tps : null,
			progressAt: pl ? pl.at : null,
			decoded: null,
			decodeTps: null,
			compacting,
			compactPercent
		};
	}
};
Object.defineProperty(ModelDialController.prototype, REMOTE_METHODS_KEY, { value: Object.freeze({
	version: 1,
	methods: Object.freeze([{
		method: "status",
		invocation: { kind: "direct" }
	}])
}) });
function apply(ctx) {
	ctx.provide("modelDialController", new ModelDialController());
}
/** Session-log helpers, exported for the deploy probe (not part of the Remote). */
const _internals = {
	findNewestSessionLog,
	scanZstdFrames,
	framesToText,
	parseCompactionEvents
};
//#endregion
export { _internals, apply };
