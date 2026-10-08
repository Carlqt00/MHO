// PDF (jsPDF) + Excel (SheetJS) export for the Reports page. BOTH read the same
// ReportData that's on screen, never a separate query, so exports stay aligned
// with the dashboard filters and calculations.
import type { ReportData } from './reports'

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

function generatedLabel(d: Date): string {
  return d.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function volumeLabel(period: string, mode: ReportData['volumeMode']): string {
  const [year, month, day] = period.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.toLocaleDateString('en-PH', {
    timeZone: 'UTC',
    month: 'short',
    day: mode === 'day' ? 'numeric' : undefined,
    year: mode === 'month' ? 'numeric' : undefined,
  })
}

function periodLabel(data: ReportData): string {
  return `${data.range.label} (${data.range.from} to ${data.range.to})`
}

function nonEmptyRows<T extends { count: number }>(rows: T[]): T[] {
  return rows.filter((row) => row.count > 0)
}

export async function exportReportPdf(data: ReportData): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 44
  const green = '#047857'
  const paleGreen = '#ecfdf5'
  const text = '#0f172a'
  const muted = '#64748b'
  const border = '#d1fae5'
  let y = 46

  const ensureSpace = (height: number) => {
    if (y + height <= pageHeight - margin) return
    doc.addPage()
    y = 46
  }

  const sectionTitle = (title: string) => {
    ensureSpace(34)
    doc.setTextColor(green)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.text(title.toUpperCase(), margin, y)
    doc.setDrawColor(border)
    doc.line(margin, y + 9, pageWidth - margin, y + 9)
    y += 26
  }

  const roundedBlock = (x: number, top: number, width: number, height: number, fill = '#ffffff') => {
    doc.setFillColor(fill)
    doc.setDrawColor(border)
    doc.roundedRect(x, top, width, height, 8, 8, 'FD')
  }

  doc.setFillColor(green)
  doc.rect(0, 0, pageWidth, 108, 'F')
  doc.setTextColor('#ffffff')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.text('MHO Daraga', margin, y)
  doc.setFontSize(11)
  doc.setFont('helvetica', 'normal')
  doc.text('Municipal Health Office', margin, y + 18)
  doc.setFontSize(18)
  doc.setFont('helvetica', 'bold')
  doc.text('Appointment Reports', margin, y + 48)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  doc.text(`Period: ${periodLabel(data)}`, pageWidth - margin, y + 14, { align: 'right' })
  doc.text(`Generated: ${generatedLabel(data.generatedAt)}`, pageWidth - margin, y + 34, { align: 'right' })
  y = 138

  sectionTitle('Summary Metrics')
  const summaryCards = [
    ['Booked', data.summary.booked],
    ['Checked In', data.summary.checked_in],
    ['Served', data.summary.served],
    ['Total', data.summary.total],
  ] as const
  const cardGap = 12
  const cardWidth = (pageWidth - margin * 2 - cardGap * 3) / 4
  summaryCards.forEach(([label, value], index) => {
    const x = margin + index * (cardWidth + cardGap)
    roundedBlock(x, y, cardWidth, 62, paleGreen)
    doc.setTextColor(muted)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.text(label.toUpperCase(), x + 12, y + 20)
    doc.setTextColor(text)
    doc.setFontSize(22)
    doc.text(String(value), x + 12, y + 48)
  })
  y += 94

  sectionTitle('Appointment Trends')
  const chartX = margin
  const chartY = y
  const chartWidth = pageWidth - margin * 2
  const chartHeight = 178
  roundedBlock(chartX, chartY, chartWidth, chartHeight)
  const plotX = chartX + 44
  const plotY = chartY + 24
  const plotWidth = chartWidth - 72
  const plotHeight = 106
  const maxVolume = Math.max(1, ...data.volume.map((row) => row.total))
  doc.setDrawColor('#cbd5e1')
  doc.line(plotX, plotY, plotX, plotY + plotHeight)
  doc.line(plotX, plotY + plotHeight, plotX + plotWidth, plotY + plotHeight)
  doc.setTextColor(muted)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.text(String(maxVolume), plotX - 12, plotY + 3, { align: 'right' })
  doc.text('0', plotX - 12, plotY + plotHeight + 3, { align: 'right' })

  if (data.volume.length === 0 || data.volume.every((row) => row.total === 0)) {
    doc.setFontSize(11)
    doc.text('No appointments in this period.', chartX + chartWidth / 2, chartY + 92, { align: 'center' })
  } else {
    const barGap = 4
    const barWidth = Math.max(6, Math.min(28, (plotWidth - barGap * (data.volume.length - 1)) / data.volume.length))
    data.volume.forEach((row, index) => {
      const x = plotX + index * ((plotWidth - barWidth) / Math.max(1, data.volume.length - 1))
      const h = (row.total / maxVolume) * plotHeight
      doc.setFillColor(green)
      doc.roundedRect(x, plotY + plotHeight - h, barWidth, h, 3, 3, 'F')
      const shouldLabel =
        data.volume.length <= 12 || index === 0 || index === data.volume.length - 1 || index % 5 === 0
      if (shouldLabel) {
        doc.setTextColor(muted)
        doc.setFontSize(7)
        doc.text(volumeLabel(row.period, data.volumeMode), x + barWidth / 2, plotY + plotHeight + 16, {
          align: 'center',
          angle: data.volume.length > 12 ? 35 : 0,
        })
      }
    })
  }
  doc.setTextColor(muted)
  doc.setFontSize(8)
  doc.text(`Appointments by ${data.volumeMode === 'month' ? 'month' : 'day'}`, chartX + 14, chartY + chartHeight - 14)
  y += chartHeight + 32

  sectionTitle('Service Distribution')
  const serviceRows = nonEmptyRows(data.byService)
  const serviceHeight = Math.max(90, 34 + Math.max(1, serviceRows.length) * 24)
  ensureSpace(serviceHeight + 10)
  roundedBlock(margin, y, pageWidth - margin * 2, serviceHeight)
  if (serviceRows.length === 0) {
    doc.setTextColor(muted)
    doc.setFontSize(11)
    doc.text('No appointments in this period.', pageWidth / 2, y + 52, { align: 'center' })
  } else {
    const maxService = Math.max(1, ...serviceRows.map((row) => row.count))
    serviceRows.forEach((row, index) => {
      const rowY = y + 28 + index * 24
      const barX = margin + 160
      const barWidth = ((pageWidth - margin * 2 - 220) * row.count) / maxService
      doc.setTextColor(text)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(10)
      doc.text(row.name, margin + 14, rowY)
      doc.setFillColor(paleGreen)
      doc.roundedRect(barX, rowY - 9, pageWidth - margin * 2 - 220, 12, 4, 4, 'F')
      doc.setFillColor(green)
      doc.roundedRect(barX, rowY - 9, Math.max(3, barWidth), 12, 4, 4, 'F')
      doc.setFont('helvetica', 'bold')
      doc.text(String(row.count), pageWidth - margin - 14, rowY, { align: 'right' })
    })
  }
  y += serviceHeight + 32

  sectionTitle('Rates')
  const rateCards = [
    ['No-show Rate', pct(data.rates.noShowRate)],
    ['Cancellation Rate', pct(data.rates.cancelledRate)],
  ] as const
  rateCards.forEach(([label, value], index) => {
    const width = (pageWidth - margin * 2 - 12) / 2
    const x = margin + index * (width + 12)
    roundedBlock(x, y, width, 66, '#ffffff')
    doc.setTextColor(muted)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.text(label.toUpperCase(), x + 14, y + 22)
    doc.setTextColor(green)
    doc.setFontSize(22)
    doc.text(value, x + 14, y + 50)
  })
  y += 96

  doc.setTextColor(muted)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.text(
    'Source: MHO Reports dashboard. Export uses the same filtered data shown on screen.',
    margin,
    Math.min(y, pageHeight - 36)
  )

  doc.save(`mho-report-${data.range.fileLabel}.pdf`)
}

export async function exportReportExcel(data: ReportData): Promise<void> {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  const s = data.summary

  const appendSheet = (
    name: string,
    rows: (string | number)[][],
    widths: number[],
    merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = []
  ) => {
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = widths.map((wch) => ({ wch }))
    if (merges.length > 0) ws['!merges'] = merges
    XLSX.utils.book_append_sheet(wb, ws, name)
  }

  appendSheet(
    'Summary',
    [
      ['MHO Daraga Appointment Report', ''],
      ['Report Period', periodLabel(data)],
      ['Generated Date/Time', generatedLabel(data.generatedAt)],
      [],
      ['Metric', 'Value'],
      ['Booked', s.booked],
      ['Checked In', s.checked_in],
      ['Served', s.served],
      ['Total', s.total],
      ['No-show Rate', pct(data.rates.noShowRate)],
      ['Cancellation Rate', pct(data.rates.cancelledRate)],
      [],
      ['Patient Statistics', ''],
      ['Total Registered Patients', data.patients.total],
      ['New Registrations', data.patients.newInRange],
      ['Patients With Appointment', data.patients.active],
    ],
    [30, 34],
    [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 1 } },
      { s: { r: 12, c: 0 }, e: { r: 12, c: 1 } },
    ]
  )

  appendSheet(
    'Appointment Trends',
    [
      ['Date', 'Appointment Count'],
      ...(data.volume.length
        ? data.volume.map((row) => [volumeLabel(row.period, data.volumeMode), row.total])
        : [['No appointments in this period.', 0]]),
    ],
    [22, 22]
  )

  appendSheet(
    'By Service',
    [
      ['Service', 'Appointments'],
      ...(data.byService.length
        ? data.byService.map((row) => [row.name, row.count])
        : [['No appointments in this period.', 0]]),
    ],
    [30, 18]
  )

  appendSheet(
    'By Provider',
    [
      ['Provider', 'Appointments'],
      ...(data.byProvider.length
        ? data.byProvider.map((row) => [row.name, row.count])
        : [['No appointments in this period.', 0]]),
    ],
    [34, 18]
  )

  XLSX.writeFile(wb, `mho-report-${data.range.fileLabel}.xlsx`)
}
