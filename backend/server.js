const cors = require('cors');
const express = require('express');
const { v4: uuid } = require('uuid');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const app = express();

app.use(cors());
app.use(express.json());

const jobs = new Map();
const jobQueue = [];
const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(2000);

const WORKER_CONCURRENCY = 3;
const DOWNLOADS_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const YTDLP_PATH = path.join(__dirname, 'bin', 'yt-dlp.exe');

function runCommandCollectJSON(cmd, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args);
        let out = '';
        let err = '';
        proc.stdout.on('data', (d) => out += d.toString());
        proc.stderr.on('data', (d) => err += d.toString());
        proc.on('close', (code) => {
            if (code !== 0) return reject(new Error(`Exit ${code}: ${err || out}`));
            try {
                const json = JSON.parse(out);
                resolve(json);
            } catch (e) {
                reject(new Error('Failed to parse JSON from command output: ' + e.message + '\n' + out));
            }
        });
    });
}

app.post('/api/formats', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing url' });

    try {
        await new Promise((r, rej) => {
            const p = spawn(YTDLP_PATH, ['--version']);
            p.on('close', (c) => c === 0 ? r() : rej(new Error('yt-dlp not available')));
        });
    } catch (err) {
        return res.status(500).json({ error: 'yt-dlp not found on server. Ensure yt-dlp.exe is in backend/bin/' });
    }

    try {
        const flatArgs = ['--flat-playlist', '-J', url];
        const flatJson = await runCommandCollectJSON(YTDLP_PATH, flatArgs).catch(() => null);

        let probeUrl = url;
        if (flatJson && Array.isArray(flatJson.entries) && flatJson.entries.length > 0) {
            const first = flatJson.entries[0];
            if (first && first.url) {
                probeUrl = first.url.startsWith('http') ? first.url : `https://www.youtube.com/watch?v=${first.url}`;
            }
        }

        const json = await runCommandCollectJSON(YTDLP_PATH, ['-J', probeUrl]);

        const formats = (json.formats || []).map(f => ({
            format_id: f.format_id,
            ext: f.ext,
            format_note: f.format_note || null,
            filesize: f.filesize || f.filesize_approx || null,
            height: f.height || null,
            width: f.width || null,
            tbr: f.tbr || null,
            acodec: f.acodec || null,
            vcodec: f.vcodec || null,
            url: f.url
        }));

        const unique = {};
        for (const f of formats) {
            if (!unique[f.format_id]) unique[f.format_id] = f;
        }
        const formatList = Object.values(unique).sort((a, b) => {
            const ah = a.height || 0; const bh = b.height || 0;
            if (ah !== bh) return bh - ah;
            return (b.tbr || 0) - (a.tbr || 0);
        });

        res.json({ title: json.title, id: json.id, thumbnail: json.thumbnail, formats: formatList });
    } catch (err) {
        console.error('Error probing formats:', err);
        res.status(500).json({ error: 'Failed to probe formats', details: String(err) });
    }
});

app.post('/api/download', async (req, res) => {
    const { url, type, format_id, playlistLength } = req.body;
    if (!url || !type || !format_id) return res.status(400).json({ error: 'Missing url/type/format_id' });
    if (!['video', 'playlist'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

    const jobId = uuid();
    const job = {
        id: jobId,
        url,
        type,
        status: 'queued',
        progress: 0,
        format_id,
        items: [],
        result: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    if (type === 'playlist' && playlistLength && Number.isInteger(playlistLength) && playlistLength > 0) {
        job.items = Array.from({ length: playlistLength }, (_, i) => ({ index: i + 1, title: `Item ${i + 1}`, progress: 0, status: 'queued', result: null }));
    }

    jobs.set(jobId, job);
    jobQueue.push(jobId);
    jobEvents.emit('job:created', { jobId });

    res.json({ jobId });
});

app.get('/api/status/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json(job);
});

app.get('/api/events/:id', (req, res) => {
    const jobId = req.params.id;
    const job = jobs.get(jobId);
    if (!job) return res.status(404).end();

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 10000\n\n');

    const send = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send('init', { job });

    const onProgress = (p) => { if (p.jobId === jobId) send('progress', p); };
    const onFinished = (p) => { if (p.jobId === jobId) send('finished', p); };
    const onError = (p) => { if (p.jobId === jobId) send('error', p); };

    jobEvents.on('job:progress', onProgress);
    jobEvents.on('job:finished', onFinished);
    jobEvents.on('job:error', onError);

    req.on('close', () => {
        jobEvents.removeListener('job:progress', onProgress);
        jobEvents.removeListener('job:finished', onFinished);
        jobEvents.removeListener('job:error', onError);
    });
});

app.get('/downloads/:jobId/:file', (req, res) => {
    const filePath = path.join(DOWNLOADS_DIR, req.params.jobId, req.params.file);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    res.download(filePath);
});

let activeWorkers = 0;

async function ensureDir(dir) { await fs.promises.mkdir(dir, { recursive: true }); }

function parseProgressLine(line) {
    const m = line.match(/(\d{1,3}\.\d|\d{1,3})%/);
    if (m) return parseFloat(m[0].replace('%', ''));
    return null;
}

async function processJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;
    try {
        job.status = 'processing';
        job.updatedAt = new Date().toISOString();
        jobEvents.emit('job:progress', { jobId, status: job.status, progress: job.progress });

        const jobDir = path.join(DOWNLOADS_DIR, jobId);
        await ensureDir(jobDir);

        if (job.type === 'video') {
            const outTemplate = path.join(jobDir, '%(title)s - %(id)s.%(ext)s');
            const args = ['-f', job.format_id, '-o', outTemplate, job.url, '--newline'];

            await runYtDlpAndTrack(job, args, jobDir);
            job.status = 'finished';
            job.progress = 100;
            job.result = { type: 'file', path: jobDir };
            job.updatedAt = new Date().toISOString();
            jobEvents.emit('job:finished', { jobId, result: job.result });
            return;
        }

        if (job.type === 'playlist') {
            const outTemplate = path.join(jobDir, '%(playlist_index)s - %(title)s.%(ext)s');
            const args = ['-f', job.format_id, '-o', outTemplate, job.url, '--yes-playlist', '--newline'];

            await runYtDlpAndTrack(job, args, jobDir, true);

            const files = await fs.promises.readdir(jobDir).catch(() => []);
            job.items = files.map((f, i) => ({
                index: i + 1,
                title: f,
                progress: 100,
                status: 'done',
                result: `/downloads/${jobId}/${encodeURIComponent(f)}`
            }));
            job.status = 'finished';
            job.progress = 100;
            job.result = { type: 'dir', path: jobDir };
            job.updatedAt = new Date().toISOString();
            jobEvents.emit('job:finished', { jobId, result: job.result });
            return;
        }
    } catch (err) {
        job.status = 'failed';
        job.error = String(err);
        job.updatedAt = new Date().toISOString();
        jobEvents.emit('job:error', { jobId, error: job.error });
        console.error('Job failed', jobId, err);
    }
}

function runYtDlpAndTrack(job, args, jobDir, isPlaylist = false) {
    return new Promise((resolve, reject) => {
        const proc = spawn(YTDLP_PATH, args, { cwd: jobDir });

        proc.stdout.setEncoding('utf8');
        proc.stderr.setEncoding('utf8');

        const handleLine = (line) => {
            const p = parseProgressLine(line);
            if (p !== null) {
                job.progress = Math.max(job.progress, Math.floor(p));
                job.updatedAt = new Date().toISOString();
                jobEvents.emit('job:progress', { jobId: job.id, progress: job.progress, line });
            }

            const destMatch = line.match(/Destination:\s*(.*)/);
            if (destMatch) {
                const filename = destMatch[1].trim();
                if (isPlaylist) {
                    job.items.push({
                        index: job.items.length + 1,
                        title: path.basename(filename),
                        progress: 0,
                        status: 'queued',
                        result: null
                    });
                    jobEvents.emit('job:progress', { jobId: job.id, itemAdded: path.basename(filename), itemsCount: job.items.length });
                }
            }
        };

        proc.stdout.on('data', (chunk) => {
            const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
            for (const l of lines) handleLine(l);
        });
        proc.stderr.on('data', (chunk) => {
            const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
            for (const l of lines) handleLine(l);
        });

        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
            if (code === 0) return resolve();
            return reject(new Error('yt-dlp exited with code ' + code));
        });
    });
}

async function workerLoop() {
    while (true) {
        if (activeWorkers >= WORKER_CONCURRENCY) {
            await new Promise(r => setTimeout(r, 200));
            continue;
        }
        const nextJobId = jobQueue.shift();
        if (!nextJobId) {
            await new Promise(r => setTimeout(r, 200));
            continue;
        }
        const job = jobs.get(nextJobId);
        if (!job) continue;
        activeWorkers++;
        processJob(nextJobId).finally(() => { activeWorkers--; });
    }
}

// Start worker loops safely
(async () => {
    for (let i = 0; i < WORKER_CONCURRENCY; i++) {
        workerLoop();
    }
})();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
