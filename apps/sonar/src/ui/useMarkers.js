import { useEffect, useState } from 'react';

/**
 * The marks of what changed `target` (a web app or slot) over `span`, App's markersOf: { markers, errors },
 * or null until they're read (and for anything else). Read again when `again` changes (a new result).
 */
export function useMarkers(ctx, target, span, again) {
  const [marks, setMarks] = useState(null);
  const web = target && !target.type ? target : null;
  useEffect(() => {
    if (!web || !span) return setMarks(null);
    let live = true;
    ctx.markersOf(web, span).then(
      (m) => live && setMarks(m),
      () => live && setMarks(null),
    );
    return () => {
      live = false;
    };
  }, [web?.id, span?.iso, again]);
  return marks;
}
