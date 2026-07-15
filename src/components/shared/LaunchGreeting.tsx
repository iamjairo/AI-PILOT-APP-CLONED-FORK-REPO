/**
 * @file Launch greeting — on app start the AI-Pilot robot pops in, waves,
 * says "Hello!", then the overlay fades away into the app.
 *
 * - Shows once per app launch (module flag survives HMR remounts).
 * - Click anywhere (or Escape) skips immediately.
 * - Honors prefers-reduced-motion: skips straight to the app.
 */
import { useEffect, useState } from 'react';

let greetedThisLaunch = false;

const HOLD_MS = 4200; // time before the fade starts
const FADE_MS = 650; // overlay fade duration

export function LaunchGreeting() {
  const [phase, setPhase] = useState<'in' | 'fading' | 'done'>(() => {
    if (greetedThisLaunch) return 'done';
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      greetedThisLaunch = true;
      return 'done';
    }
    return 'in';
  });

  useEffect(() => {
    if (phase !== 'in') return;
    greetedThisLaunch = true;
    const t = setTimeout(() => setPhase('fading'), HOLD_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPhase('fading');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== 'fading') return;
    const t = setTimeout(() => setPhase('done'), FADE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === 'done') return null;

  return (
    <div
      onClick={() => setPhase('fading')}
      className="lg-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#1a1b1e',
        cursor: 'pointer',
        opacity: phase === 'fading' ? 0 : 1,
        transition: `opacity ${FADE_MS}ms ease`,
      }}
      aria-label="AI-Pilot is starting"
    >
      <style>{`
        @keyframes lg-pop { 0% { opacity: 0; transform: scale(.6) translateY(24px); } 70% { transform: scale(1.05) translateY(-4px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
        @keyframes lg-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes lg-bubble { 0% { opacity: 0; transform: scale(0); } 60% { transform: scale(1.12); } 100% { opacity: 1; transform: scale(1); } }
        @keyframes lg-wave { 0%,100% { transform: rotate(0deg); } 30% { transform: rotate(-14deg); } 60% { transform: rotate(6deg); } }
        @keyframes lg-blink { 0%, 88%, 100% { transform: scaleY(1); } 93% { transform: scaleY(.12); } }
        .lg-stage { animation: lg-pop .55s cubic-bezier(.34,1.4,.5,1) both; }
        .lg-bobber { animation: lg-bob 2.4s ease-in-out .6s infinite; }
        .lg-bubble { animation: lg-bubble .4s cubic-bezier(.34,1.56,.64,1) .55s both; transform-origin: 18% 92%; }
        @keyframes lg-twirl { 0% { transform: rotate(0deg) scale(1); } 45% { transform: rotate(200deg) scale(.92); } 100% { transform: rotate(360deg) scale(1); } }
        .lg-arm { animation: lg-wave 1.1s ease-in-out .7s 3; transform-box: view-box; transform-origin: 566px 505px; }
        .lg-eyes { animation: lg-blink 3.2s ease-in-out 1s infinite; transform-box: view-box; transform-origin: 448px 330px; }
        .lg-bubble { transform-box: view-box; transform-origin: 610px 370px; }
        .lg-twirler { animation: lg-twirl .9s cubic-bezier(.45,.05,.35,1) 2.1s 1 both; transform-box: view-box; transform-origin: 448px 470px; }
      `}</style>

      <div className="lg-stage">
        <div className="lg-bobber">
          <svg width="440" height="440" viewBox="120 100 720 720" aria-hidden="true">
            {/* speech bubble */}
            <g className="lg-bubble">
              <circle cx="710" cy="252" r="104" fill="#d5475a" />
              <path d="M636 322 L596 384 L676 348 Z" fill="#d5475a" />
              <text
                x="710"
                y="252"
                textAnchor="middle"
                dominantBaseline="central"
                fill="#ffffff"
                fontSize="44"
                fontWeight="700"
                fontFamily="system-ui, sans-serif"
              >
                Hello!
              </text>
            </g>

            {/* robot — wrapped so the twirl spins him while the bubble stays put */}
            <g className="lg-twirler">
            {/* antenna */}
            <rect x="438" y="180" width="20" height="70" rx="10" fill="#5f6379" />
            <ellipse cx="448" cy="172" rx="22" ry="26" fill="#5f6379" />

            {/* ears */}
            <circle cx="306" cy="330" r="34" fill="#5f6379" />
            <circle cx="590" cy="330" r="34" fill="#5f6379" />

            {/* head */}
            <rect x="318" y="248" width="260" height="164" rx="36" fill="#ece9f7" />
            <rect x="346" y="278" width="204" height="104" rx="20" fill="#8fc9f0" />
            <g className="lg-eyes">
              <circle cx="408" cy="330" r="24" fill="#2f3040" />
              <circle cx="488" cy="330" r="24" fill="#2f3040" />
              <circle cx="416" cy="322" r="8" fill="#ffffff" />
              <circle cx="496" cy="322" r="8" fill="#ffffff" />
            </g>
            {/* happy smile */}
            <path d="M412 356 Q448 380 484 356" stroke="#2f3040" strokeWidth="9" strokeLinecap="round" fill="none" />

            {/* neck */}
            <rect x="408" y="412" width="80" height="42" rx="12" fill="#2f3040" />

            {/* left arm (static) */}
            <path d="M330 500 C 250 520 240 600 260 660 C 268 682 300 682 306 658 C 296 610 306 560 350 546 Z" fill="#5f6379" />
            <circle cx="283" cy="676" r="30" fill="#4d9df5" />

            {/* right arm — waves hello */}
            <g className="lg-arm">
              <path d="M566 500 C 646 520 656 600 636 660 C 628 682 596 682 590 658 C 600 610 590 560 546 546 Z" fill="#5f6379" />
              <circle cx="613" cy="676" r="30" fill="#4d9df5" />
            </g>

            {/* body */}
            <rect x="330" y="452" width="236" height="216" rx="40" fill="#ece9f7" />
            <rect x="368" y="496" width="160" height="18" rx="9" fill="#cfcbe6" />
            <rect x="368" y="536" width="160" height="18" rx="9" fill="#cfcbe6" />
            <rect x="368" y="576" width="160" height="18" rx="9" fill="#cfcbe6" />

            {/* lower dome + tail */}
            <path d="M366 668 A 82 78 0 0 0 530 668 Z" fill="#9fcdf3" />
            <ellipse cx="448" cy="756" rx="26" ry="30" fill="#5f6379" />
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}

export default LaunchGreeting;
