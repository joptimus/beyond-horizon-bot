const VOTE_INDEX = new Map<string, number>(); // messageId -> issueNumber

export function linkVoteMessage(messageId: string, issueNumber: number) {
  VOTE_INDEX.set(messageId, issueNumber);
}

export function getIssueFromVoteMessage(messageId: string): number | undefined {
  return VOTE_INDEX.get(messageId);
}