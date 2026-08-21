// PDF (jsPDF) + Excel (SheetJS) export for the Reports page. BOTH read the same
// ReportData that's on screen — never a separate query — so an exported file
// can't drift from the displayed figures. Each file carries the date range and
// a generation timestamp so a printout is unambiguous about its period. Heavy
// deps are dynamically imported so they load only when the user exports.
import type { ReportData } from './reports'

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

function generatedLabel(d: Date): string {
  return d.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function periodLine(data: ReportData): string {
  return `Period: ${data.range.label}  (${data.range.from} to ${data.range.to})`
}

export async function exportReportPdf(data: ReportData): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const marginX = 48
  const bottom = doc.internal.pageSize.getHeight() - 48
  let y = 56

  const write = (text: string, size = 11, bold = false, gap = 16) => {
    if (y > bottom) {
      doc.addPage()
      y = 56
    }
    doc.setFontSize(size)
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.text(text, marginX, y)
    y += gap
  }

  write('MHO Daraga — Report', 16, true, 22)
  write(periodLine(data))
  write(`Generated: ${generatedLabel(data.generatedAt)}`, 11, false, 22)

  const s = data.summary
  write('Appointments Summary', 13, true)
  write(`Booked: ${s.booked}`)
  write(`Checked in: ${s.checked_in}`)
  write(`Served: ${s.served}`)
  write(`No-show: ${s.no_show}`)
  write(`Cancelled: ${s.cancelled}`)
  write(`Total: ${s.total}`, 11, true, 22)

  write('Rates', 13, true)
  write(`No-show rate: ${pct(data.rates.noShowRate)}`)
  write(`Cancellation rate: ${pct(data.rates.cancelledRate)}`, 11, false, 22)

  write('By Service', 13, true)
  if (data.byService.length === 0) write('No appointments in this period.')
  else data.byService.forEach((r) => write(`${r.name}: ${r.count}`))
  y += 6

  write('By Provider', 13, true)
  if (data.byProvider.length === 0) write('No appointments in this period.')
  else data.byProvider.forEach((r) => write(`${r.name}: ${r.count}`))
  y += 6

  write('Patient Statistics', 13, true)
  write(`Total registered patients: ${data.patients.total}`)
  write(`New registrations (this period): ${data.patients.newInRange}`)
  write(`Patients with an appointment (this period): ${data.patients.active}`)

  doc.save(`mho-report-${data.range.fileLabel}.pdf`)
}

export async function exportReportExcel(data: ReportData): Promise<void> {
  const XLSX = await import('xlsx')
  const s = data.summary
  const rows: (string | number)[][] = [
    ['MHO Daraga — Report'],
    [periodLine(data)],
    [`Generated: ${generatedLabel(data.generatedAt)}`],
    [],
    ['Appointments Summary'],
    ['Booked', s.booked],
    ['Checked in', s.checked_in],
    ['Served', s.served],
    ['No-show', s.no_show],
    ['Cancelled', s.cancelled],
    ['Total', s.total],
    [],
    ['Rates'],
    ['No-show rate', pct(data.rates.noShowRate)],
    ['Cancellation rate', pct(data.rates.cancelledRate)],
    [],
    ['By Service', 'Count'],
    ...(data.byService.length
      ? data.byService.map((r) => [r.name, r.count])
      : [['No appointments in this period.']]),
    [],
    ['By Provider', 'Count'],
    ...(data.byProvider.length
      ? data.byProvider.map((r) => [r.name, r.count])
      : [['No appointments in this period.']]),
    [],
    ['Patient Statistics'],
    ['Total registered patients', data.patients.total],
    ['New registrations (this period)', data.patients.newInRange],
    ['Patients with an appointment (this period)', data.patients.active],
  ]

  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Report')
  XLSX.writeFile(wb, `mho-report-${data.range.fileLabel}.xlsx`)
}
