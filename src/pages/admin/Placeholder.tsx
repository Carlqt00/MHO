// Shared shell for admin sections that aren't built yet. Renders the section
// title plus a short "coming in a later phase" note.
export function Placeholder({ title, summary }: { title: string; summary: string }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-800">{title}</h2>
      <p className="mt-1 text-sm text-gray-500">{summary}</p>
      <div className="mt-4 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-400">
        Coming in a later phase.
      </div>
    </section>
  )
}
