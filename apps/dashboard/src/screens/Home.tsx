import { APP_NAME } from "../brand";
import { LifeboatMark } from "../components/ui";
import { hosted } from "../lib/appWallet";
import { LINKS, PROOF } from "../lib/home";
import { usePoll } from "../lib/hooks";
import { landingStart } from "../lib/onboard";

/** In-page links scroll with buttons: the app routes on `#/…`, so `#how` would be read as a route. */
const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
const SECTIONS: [string, string][] = [
  ["hm-how", "How it works"],
  ["hm-proof", "Proof"],
  ["hm-limits", "Security"],
  ["hm-faq", "FAQ"],
];
const fmt = (n: number) => n.toLocaleString("en-US");
const first = PROOF[0];

/** What a visitor sees first: what Q-Lifeboat does, a real rescue on diana, and the way in. */
export function Home() {
  const status = usePoll(() => hosted.status(), 30_000, "home-status");
  const gate = landingStart(status.data, status.data ? null : status.error);
  const watching = status.data?.activeGuardians;

  return (
    <div className="hm">
      <header className="hm-top">
        <div className="hm-wrap">
          <a className="hm-brand" href="#/home">
            <LifeboatMark size={28} />
            {APP_NAME}
          </a>
          <nav aria-label="Homepage sections">
            {SECTIONS.map(([id, label]) => (
              <button key={id} type="button" onClick={() => scrollTo(id)}>
                {label}
              </button>
            ))}
            <a href={LINKS.github} target="_blank" rel="noreferrer noopener">
              GitHub
            </a>
          </nav>
          <div className="hm-right">
            <span className="hm-net">diana testnet</span>
            <a className="hm-btn rescue small" href="#/start">
              Get protected
            </a>
          </div>
        </div>
      </header>

      <section className="hm-hero">
        <div className="hm-wrap">
          <div>
            <div className="hm-eyebrow">For QoreChain accounts · Post-quantum rescue</div>
            <h1>
              Your wallet key leaks. <em>Your tokens don't.</em>
            </h1>
            <p className="hm-sub">
              A Guardian watches your account. The moment someone else spends from it, it moves your tokens into a vault that only your post-quantum key
              can open. Set up in your browser in about three minutes, with no extension.
            </p>
            <div className="hm-ctas">
              <a className="hm-btn rescue" href="#/start">
                Get protected
              </a>
              <button type="button" className="hm-btn outline" onClick={() => scrollTo("hm-proof")}>
                See a real rescue
              </button>
            </div>
            <p className="hm-fine">
              Testnet only. Free test tokens, nothing real at stake.
              {watching !== undefined && watching > 0 ? ` ${watching} Guardian${watching === 1 ? "" : "s"} on watch now.` : ""}
            </p>
            {!gate.enabled && status.data ? (
              <p className="hm-paused" role="status">
                {gate.reason}
              </p>
            ) : null}
          </div>

          <figure className="hm-replay" aria-label="A real rescue on the diana testnet">
            <div className="hm-replay-head">
              <b>A real rescue on diana</b>
              <span className="mono">Nov 26, owner {first.owner}</span>
            </div>
            <ol className="hm-tl">
              <li className="bad">
                <span className="blk">#{fmt(first.leakBlock)}</span>
                <span className="dot" />
                <div>
                  <span className="tag">Leaked key</span>
                  <p>The account's own ECDSA key sends fUSD to an address it never trusted.</p>
                </div>
              </li>
              <li className="mid">
                <span className="blk">seconds later</span>
                <span className="dot" />
                <div>
                  <span className="tag">Guardian</span>
                  <p>Fixed rules match: unknown recipient. No AI decides this.</p>
                </div>
              </li>
              <li className="good">
                <span className="blk">#{fmt(first.rescueBlock)}</span>
                <span className="dot" />
                <div>
                  <span className="tag">Rescued</span>
                  <p>fUSD, fETH and fBTC land in the vault. Only the owner's post-quantum key can take them out.</p>
                </div>
              </li>
            </ol>
            <div className="hm-stats">
              <div>
                <b>{first.rescueBlock - first.leakBlock} blocks</b>
                <span>leak to rescue</span>
              </div>
              <div>
                <b>{first.kept}</b>
                <span>of fUSD kept</span>
              </div>
              <div>
                <b>3 of 3</b>
                <span>tokens rescued</span>
              </div>
            </div>
            <figcaption className="hm-replay-foot">
              <span className="mono">rescue {first.rescueTx}</span>
              <button type="button" onClick={() => scrollTo("hm-proof")}>
                Check every rescue ↓
              </button>
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="hm-band white">
        <div className="hm-wrap">
          <div className="hm-sh">
            <div className="hm-eyebrow">Why now</div>
            <h2>One leaked key is enough to empty an account today</h2>
            <p>
              Every EVM account is guarded by one ECDSA key. A phishing page or a bad backup can expose it now; a large enough quantum computer could work it
              out from your public key later. Whoever holds it can sign anything.
            </p>
          </div>
          <div className="hm-why">
            <div>
              <h3>Leaks happen now</h3>
              <p>Phishing, malware and copied seed phrases already drain accounts every day.</p>
            </div>
            <div>
              <h3>Q-Day comes later</h3>
              <p>Quantum computers threaten the signature itself. Moving value under a post-quantum key is the way out.</p>
            </div>
            <div>
              <h3>Seconds matter</h3>
              <p>A thief empties an account in a few blocks. Protection has to act on its own, faster than you can react.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="hm-band" id="hm-how">
        <div className="hm-wrap">
          <div className="hm-sh">
            <div className="hm-eyebrow">How it works</div>
            <h2>Watch, rescue, recover</h2>
            <p>Three things happen, and only one of them needs you.</p>
          </div>
          <ol className="hm-steps">
            <li>
              <span className="n">1</span>
              <h3>Watch</h3>
              <p>Your Guardian follows every transfer and approval from your account, block by block.</p>
            </li>
            <li>
              <span className="n">2</span>
              <h3>Rescue</h3>
              <p>If one goes somewhere you don't trust, it moves your tokens into your vault within a block or two.</p>
            </li>
            <li>
              <span className="n">3</span>
              <h3>Recover</h3>
              <p>You take them out to a new, safe address, signed with the post-quantum key from your recovery code.</p>
            </li>
          </ol>
          <div className="hm-diagram">
            <FlowDiagram />
          </div>
        </div>
      </section>

      <section className="hm-band white" id="hm-proof">
        <div className="hm-wrap">
          <div className="hm-sh">
            <div className="hm-eyebrow">Proof</div>
            <h2>Don't take our word for it</h2>
            <p>
              Three fresh browsers set up protection on this public instance and attacked themselves on Nov 26. Every rescue is an EVM transaction whose
              receipt you can check on diana yourself.
            </p>
          </div>
          <div className="hm-proof">
            <table>
              <thead>
                <tr>
                  <th>Owner</th>
                  <th>Leak (block)</th>
                  <th>Rescue (block)</th>
                  <th>Leak to rescue</th>
                  <th>Value kept</th>
                  <th>Rescue tx</th>
                </tr>
              </thead>
              <tbody>
                {PROOF.map((p) => (
                  <tr key={p.owner}>
                    <td className="mono">{p.owner}</td>
                    <td>{fmt(p.leakBlock)}</td>
                    <td>{fmt(p.rescueBlock)}</td>
                    <td className="ok">{p.rescueBlock - p.leakBlock} blocks</td>
                    <td className="ok">{p.kept}</td>
                    <td className="mono">{p.rescueTx}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hm-verify">
            <div>
              <b>Signed reports</b>
              Every rescue comes with a report signed by your Guardian and co-signed with its post-quantum key.
            </div>
            <div>
              <b>Checked in your browser</b>
              The app checks each report against the chain itself: the vault, the key, the rescue transactions.
            </div>
            <div>
              <b>Every hash in the open</b>
              The <a href={LINKS.evidence} target="_blank" rel="noreferrer noopener">evidence log</a> lists each testnet transaction behind every claim
              on this page.
            </div>
          </div>
        </div>
      </section>

      <section className="hm-band" id="hm-limits">
        <div className="hm-wrap">
          <div className="hm-sh">
            <div className="hm-eyebrow">Security</div>
            <h2>What your Guardian can't do</h2>
            <p>The Guardian holds a key on your account. These limits are enforced by the chain and the vault contract, not by a promise.</p>
          </div>
          <ul className="hm-cannot">
            <li>
              <span className="x" aria-hidden="true">✓</span>
              <div>
                <h3>It can't withdraw from your vault</h3>
                <p>Only a withdrawal signed with your post-quantum key releases tokens, and you choose where they go.</p>
              </div>
            </li>
            <li>
              <span className="x" aria-hidden="true">✓</span>
              <div>
                <h3>It can't send your tokens anywhere else</h3>
                <p>Its permission on your account allows one call: rescue into your own vault.</p>
              </div>
            </li>
            <li>
              <span className="x" aria-hidden="true">✓</span>
              <div>
                <h3>Nobody can change the vault</h3>
                <p>Owner and Guardian are fixed when the vault is created. There is no admin key and no setter.</p>
              </div>
            </li>
            <li>
              <span className="x" aria-hidden="true">✓</span>
              <div>
                <h3>AI never moves funds</h3>
                <p>Fixed rules decide every rescue. AI only writes the plain-English summary of what happened.</p>
              </div>
            </li>
          </ul>
          <div className="hm-open">
            {(
              [
                [LINKS.github, "Open source", "MIT license, the whole stack on GitHub.", "View code"],
                [LINKS.threatModel, "Threat model", "26 threats, what stops each one, and what's left.", "Read it"],
                [LINKS.audit, "Audit", "QoreChain's AI audit findings and their fixes.", "See findings"],
                [LINKS.evidence, "Evidence log", "Every testnet tx hash behind every claim.", "Check hashes"],
              ] as const
            ).map(([href, title, text, cta]) => (
              <a key={title} href={href} target="_blank" rel="noreferrer noopener">
                <b>{title}</b>
                <span>{text}</span>
                <i>{cta} →</i>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className="hm-band white" id="hm-faq">
        <div className="hm-wrap">
          <div className="hm-sh">
            <div className="hm-eyebrow">FAQ</div>
            <h2>Straight answers</h2>
          </div>
          <div className="hm-faq">
            <details open>
              <summary>Does it cost anything?</summary>
              <p>No. This is the diana testnet: you get a free starter pack of 2.5 test QOR for fees, and the test tokens have no value.</p>
            </details>
            <details>
              <summary>Can it save an account whose key was already stolen?</summary>
              <p>
                No. The Guardian has to be in place before the leak. Once it is, it moves what's left the moment the thief spends. A drainer that empties
                everything in the same block can still win.
              </p>
            </details>
            <details>
              <summary>What if Q-Lifeboat shuts down?</summary>
              <p>Your vault is a contract on chain with no admin. The service can't touch it, and withdrawals only need your post-quantum key.</p>
            </details>
            <details>
              <summary>Is my recovery code stored anywhere?</summary>
              <p>No. It is shown once when you create your wallet. Write it on paper: it is the only way to sign a withdrawal.</p>
            </details>
            <details>
              <summary>What if I lose this browser?</summary>
              <p>
                Today the wallet lives in this browser, encrypted with your password. Keep your password and recovery code. Recovery on a new device is on
                the roadmap.
              </p>
            </details>
          </div>
        </div>
      </section>

      <section className="hm-final">
        <div className="hm-wrap">
          <div>
            <h2>Set up a Guardian in about three minutes</h2>
            <p>Then try an attack on yourself and watch it rescue your tokens.</p>
          </div>
          <a className="hm-btn rescue" href="#/start">
            Get protected
          </a>
        </div>
      </section>

      <footer className="hm-foot">
        <div className="hm-wrap">
          <span>{APP_NAME} · an entry for QoreChain Build Before Q-Day · MIT</span>
          <span>
            <a href={LINKS.github} target="_blank" rel="noreferrer noopener">
              GitHub
            </a>{" "}
            ·{" "}
            <a href={LINKS.threatModel} target="_blank" rel="noreferrer noopener">
              Threat model
            </a>{" "}
            ·{" "}
            <a href={LINKS.evidence} target="_blank" rel="noreferrer noopener">
              Evidence
            </a>{" "}
            · diana testnet only
          </span>
        </div>
      </footer>
    </div>
  );
}

/** Account → thief / Guardian → vault → new address, in the app's colours. */
function FlowDiagram() {
  return (
    <svg
      viewBox="0 0 900 190"
      role="img"
      aria-label="A thief with your key sends from your account; the Guardian sees it and rescues your tokens into your vault; only your post-quantum key withdraws them to a new address"
    >
      <g fontFamily="Archivo, sans-serif" fontSize="14" fill="#0f2236">
        <rect x="20" y="60" width="170" height="70" rx="12" fill="#fff" stroke="#d6dee6" />
        <text x="105" y="90" textAnchor="middle" fontWeight="700">Your account</text>
        <text x="105" y="112" textAnchor="middle" fill="#5a6878" fontSize="12">ECDSA key</text>
        <rect x="250" y="8" width="160" height="56" rx="12" fill="#fdeee6" stroke="#f4c9b4" />
        <text x="330" y="33" textAnchor="middle" fontWeight="700" fill="#b03a0b">Thief</text>
        <text x="330" y="52" textAnchor="middle" fill="#b03a0b" fontSize="12">has your key</text>
        <rect x="250" y="126" width="160" height="56" rx="12" fill="#fff" stroke="#d6dee6" />
        <text x="330" y="151" textAnchor="middle" fontWeight="700">Guardian</text>
        <text x="330" y="170" textAnchor="middle" fill="#5a6878" fontSize="12">may only call rescue</text>
        <rect x="480" y="60" width="170" height="70" rx="12" fill="#e4f3ee" stroke="#0b6b50" />
        <text x="565" y="90" textAnchor="middle" fontWeight="700" fill="#0b6b50">Your vault</text>
        <text x="565" y="112" textAnchor="middle" fill="#0b6b50" fontSize="12">no admin key</text>
        <rect x="710" y="60" width="170" height="70" rx="12" fill="#fff" stroke="#d6dee6" />
        <text x="795" y="90" textAnchor="middle" fontWeight="700">New safe address</text>
        <text x="795" y="112" textAnchor="middle" fill="#5a6878" fontSize="12">your choice</text>
        <path d="M190 80 L250 40" stroke="#e8501a" strokeWidth="2" fill="none" />
        <text x="198" y="48" fill="#b03a0b" fontSize="12">1. sends</text>
        <path d="M330 64 L330 126" stroke="#0f2236" strokeWidth="2" strokeDasharray="5 4" fill="none" />
        <text x="338" y="100" fill="#5a6878" fontSize="12">2. sees it</text>
        <path d="M410 154 L480 112" stroke="#0b6b50" strokeWidth="2.5" fill="none" />
        <text x="418" y="170" fill="#0b6b50" fontSize="12">3. rescues</text>
        <path d="M650 95 L710 95" stroke="#0b6b50" strokeWidth="2.5" fill="none" />
        <text x="652" y="84" fill="#0b6b50" fontSize="12">4. you</text>
        <text x="644" y="150" fill="#5a6878" fontSize="12">post-quantum key only</text>
      </g>
    </svg>
  );
}
