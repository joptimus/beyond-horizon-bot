const MAX_ENTRIES = 100;

export interface ActivityEntry {
	id: string;
	time: string;
	text: string;
	tag: string;
	color: string;
}

const log: ActivityEntry[] = [];

export function push(entry: Omit<ActivityEntry, 'id' | 'time'>) {
	log.unshift({
		id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
		time: new Date().toISOString(),
		...entry,
	});
	if (log.length > MAX_ENTRIES) log.pop();
}

export function getRecent(limit = 20): ActivityEntry[] {
	return log.slice(0, limit);
}

export function getSince(afterId: string): ActivityEntry[] {
	if (!afterId) return log.slice(0, 20);
	const idx = log.findIndex(e => e.id === afterId);
	if (idx <= 0) return [];
	return log.slice(0, idx);
}
