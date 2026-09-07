/** Phantom Solana wallet integration for token-gated room access.
 *  Web-only — iOS/Android don't support browser wallet extensions. */

interface PhantomProvider {
  isPhantom: boolean;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signMessage(
    message: Uint8Array,
    display: "utf8" | "hex",
  ): Promise<{ signature: Uint8Array; publicKey: { toString(): string } }>;
}

function getProvider(): PhantomProvider | null {
  const solana = (window as any).solana;
  if (solana?.isPhantom) return solana as PhantomProvider;
  return null;
}

export function isPhantomInstalled(): boolean {
  return getProvider() !== null;
}

export async function connectPhantom(): Promise<string> {
  const provider = getProvider();
  if (!provider) throw new Error("Phantom wallet not found. Please install the Phantom extension.");
  const res = await provider.connect();
  return res.publicKey.toString();
}

export async function signWithPhantom(message: string): Promise<{ signature: string; publicKey: string }> {
  const provider = getProvider();
  if (!provider) throw new Error("Phantom wallet not found. Please install the Phantom extension.");
  const encoded = new TextEncoder().encode(message);
  const res = await provider.signMessage(encoded, "utf8");
  return {
    signature: btoa(String.fromCharCode(...res.signature)),
    publicKey: res.publicKey.toString(),
  };
}

export async function disconnectPhantom(): Promise<void> {
  const provider = getProvider();
  if (!provider) return;
  try {
    await provider.disconnect();
  } catch {
    // ignore
  }
}
