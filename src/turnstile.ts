// Loads Turnstile on demand and resolves with a single-use token.

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      remove: (id: string) => void;
    };
  }
}

let loading: Promise<void> | null = null;

function load(): Promise<void> {
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Turnstile failed to load"));
    document.head.append(s);
  });
  return loading;
}

export async function getTurnstileToken(sitekey: string, container: HTMLElement): Promise<string> {
  await load();
  return new Promise((resolve, reject) => {
    const id = window.turnstile!.render(container, {
      sitekey,
      appearance: "interaction-only", // invisible unless Cloudflare needs the visitor to click
      callback: (token: string) => {
        resolve(token);
        setTimeout(() => window.turnstile?.remove(id), 0);
      },
      "error-callback": () => reject(new Error("Turnstile error")),
    });
  });
}
