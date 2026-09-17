// Shared shell for admin sections that aren't built yet. Renders the section
// title plus a short "coming in a later phase" note.
export function Placeholder({ title, summary }: { title: string; summary: string }) {
  return (
    <section>
      <h2 className="section-title">{title}</h2>
      <p className="mt-1 muted">{summary}</p>
      <div className="empty-state mt-4">
        Coming in a later phase.
      </div>
    </section>
  )
}
