/** Decorative vector artwork only; dots and shapes never represent queue progress. */
export function QueueIllustration() {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 240 180" className="queue-illustration">
    <ellipse cx="120" cy="157" rx="82" ry="12" fill="#dcece5" />
    <circle cx="122" cy="84" r="72" fill="#e3f2eb" />
    <circle cx="43" cy="45" r="7" fill="#efdcb7" /><circle cx="197" cy="113" r="5" fill="#b9d6cf" />
    <path d="m177 30 4 7 8 1-6 6 1 8-7-4-7 4 1-8-6-6 8-1Z" fill="#dfba75" />
    <g transform="rotate(-9 120 90)"><rect x="69" y="31" width="104" height="124" rx="17" fill="#bed8cc" /><rect x="64" y="25" width="104" height="124" rx="17" fill="white" stroke="#cbdfd5" strokeWidth="2" />
      <path d="M80 51h36M80 61h57" stroke="#b5cfc3" strokeWidth="5" strokeLinecap="round" />
      <circle cx="116" cy="99" r="24" fill="#e8f4ed" /><path d="m105 99 8 8 16-17" stroke="#2d6b58" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M78 133h76" stroke="#dae8df" strokeWidth="2" strokeDasharray="4 5" />
    </g>
    <circle cx="55" cy="112" r="20" fill="#e5b78a" /><path d="M37 110c0-25 37-27 37 0-8-3-13-9-16-14-3 8-12 13-21 14Z" fill="#335c4e" />
    <path d="M25 155c0-30 60-30 60 0" fill="#6b9a86" />
    <circle cx="47" cy="115" r="1.5" fill="#4d483e" /><circle cx="62" cy="115" r="1.5" fill="#4d483e" /><path d="M51 122q4 4 8 0" stroke="#865e46" strokeWidth="2" fill="none" strokeLinecap="round" />
  </svg>;
}
