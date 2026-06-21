import { Router } from 'express';
import { generateReleaseNote, bundleCommitCount, type ReleaseBundle } from '../aiReleaseNote.js';
import { postLauncherNews } from '../gameNews.js';

const router = Router();

// POST /release-note
// Body = the aggregated cross-repo bundle from bh-release/aggregate.yml.
// Returns one of:
//   { status: 'published', id, deduped }  -> news posted (marker may advance)
//   { status: 'skipped', reason }         -> nothing player-facing (marker may advance)
//   { status: 'error', error }            -> AI/network/publish failure (marker must NOT advance)
router.post('/', async (req, res) => {
	const bundle = req.body as ReleaseBundle;

	if (!bundle || !bundle.client_tag || !Array.isArray(bundle.repos)) {
		return res.status(400).json({ status: 'error', error: 'invalid bundle: client_tag and repos[] required' });
	}

	if (bundleCommitCount(bundle) === 0) {
		return res.json({ status: 'skipped', reason: 'empty bundle (no player-relevant commits)' });
	}

	try {
		const note = await generateReleaseNote(bundle);
		if (!note.hasPlayerImpact || !note.title || !note.body) {
			return res.json({ status: 'skipped', reason: 'no player-facing changes' });
		}

		const result = await postLauncherNews({
			title: note.title,
			body: note.body,
			version_tag: bundle.client_tag,
		});
		return res.json({ status: 'published', id: result.id, deduped: result.deduped });
	} catch (err: any) {
		console.error('[ReleaseNote] failed:', err?.message || err);
		return res.status(502).json({ status: 'error', error: err?.message || String(err) });
	}
});

export default router;
