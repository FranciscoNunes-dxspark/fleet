// Line icons for the menu: 24px grid, drawn with currentColor so they follow
// the text color (muted, hover, active accent) in every theme.

const PATHS = {
  dashboard: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h14V9.5" /><path d="M10 20v-6h4v6" /></>,
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z" /></>,
  workItems: <><path d="m3 6 2 2 3-3" /><path d="m3 13 2 2 3-3" /><path d="M12 7h9" /><path d="M12 14h9" /><path d="M12 20h9" /><path d="M4 20h1" /></>,
  board: <><rect x="3" y="4" width="5" height="15" rx="1.5" /><rect x="10" y="4" width="5" height="9" rx="1.5" /><rect x="17" y="4" width="4" height="12" rx="1.5" /></>,
  epics: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>,
  pullRequests: <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5v7" /><path d="M18 15.5V9a3 3 0 0 0-3-3h-4" /><path d="m13 3-3 3 3 3" /></>,
  pipelines: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><path d="M10 6.5h4a3 3 0 0 1 3 3V14" /></>,
  production: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  team: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7" /><path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5" /></>,
  insights: <><path d="M3 20h18" /><path d="M6 16v-5" /><path d="M11 16V5" /><path d="M16 16v-8" /></>,
  users: <><path d="M12 3 4 6v5c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6z" /><circle cx="12" cy="10" r="2.5" /><path d="M8 16.5a4.5 4.5 0 0 1 8 0" /></>,
  settings: <><path d="M4 6h10" /><path d="M18 6h2" /><circle cx="16" cy="6" r="2" /><path d="M4 12h4" /><path d="M12 12h8" /><circle cx="10" cy="12" r="2" /><path d="M4 18h12" /><circle cx="18" cy="18" r="2" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>,
  signOut: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
};

export function Icon({ name, size = 16 }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
