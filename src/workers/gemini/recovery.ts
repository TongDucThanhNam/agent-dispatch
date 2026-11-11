/** A failed consultation may carry safe observed text, never a verified answer. */
export function geminiRecoveredReport(result: any): string | null {
  const recovered = result?.recoveredResponse;
  if (!result?.isError || result.cancelled || recovered?.completion !== 'unconfirmed' || typeof recovered.text !== 'string' || !recovered.text.trim()) return null;
  return 'Recovered — completion unconfirmed\n\n' + recovered.text + '\n\nFailure: ' + (result.error?.message ?? 'Completion was not confirmed.') +
    '\nSession: ' + (recovered.sessionId ?? result.sessionId ?? 'unknown') + '\nChat: ' + (recovered.url ?? result.url ?? 'unknown') +
    '\nOwnership at validation: ' + recovered.ownership + ' (' + (recovered.userId ?? 'unknown') + ')' +
    '\nInspect this chat before an explicit resume; never resend automatically.\n';
}
