// A peer name is pasted verbatim into another session's prompt as
// SendMessage to "<name>", so quotes, brackets, backslashes and control
// characters must never pass.
const SAFE_PEER_NAME = /^[^\u0000-\u001f\u007f"\\[\]]{1,128}$/;

export function isValidPeerName(name: unknown): name is string {
  return typeof name === 'string' && name.trim() !== '' && SAFE_PEER_NAME.test(name);
}
