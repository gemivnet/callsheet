import React from "react";
import {
  Document,
  Page,
  View,
  Text,
  Font,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Brief, BriefSection, BriefItem } from "./types.js";

/* ------------------------------------------------------------------ */
/*  Font registration — Lato supports Hungarian characters (ő, ű, etc) */
/* ------------------------------------------------------------------ */

const __dirname = dirname(fileURLToPath(import.meta.url));
const fontsDir = join(__dirname, "..", "fonts");

Font.register({
  family: "Inter",
  fonts: [
    { src: join(fontsDir, "Inter-Regular.ttf"), fontWeight: 400 },
    { src: join(fontsDir, "Inter-Bold.ttf"), fontWeight: 700 },
    { src: join(fontsDir, "Inter-Light.ttf"), fontWeight: 300 },
  ],
});

// Disable word hyphenation — keeps labels readable
Font.registerHyphenationCallback((word) => [word]);

/* ------------------------------------------------------------------ */
/*  Design system                                                      */
/* ------------------------------------------------------------------ */

const c = {
  ink: "#111",
  dark: "#333",
  mid: "#666",
  note: "#888",
  faint: "#bbb",
  rule: "#ccc",
  ruleLight: "#e4e4e4",
  urgentBar: "#c0392b",
  urgentBg: "#fef5f5",
};

const styles = StyleSheet.create({
  /* Page */
  page: {
    paddingTop: 36,
    paddingBottom: 44,
    paddingHorizontal: 44,
    fontFamily: "Inter",
    fontSize: 9,
    lineHeight: 1.4,
    color: c.ink,
  },

  /* Header */
  header: {
    flexDirection: "row" as const,
    justifyContent: "space-between" as const,
    alignItems: "flex-end" as const,
    paddingBottom: 5,
    borderBottomWidth: 2,
    borderBottomColor: c.ink,
    marginBottom: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: 700,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 8,
    fontWeight: 300,
    color: c.mid,
    marginTop: 5,
  },
  headerMeta: {
    fontSize: 7,
    color: c.note,
  },

  /* Sections */
  section: {
    marginBottom: 10,
  },
  sectionHeading: {
    fontSize: 7.5,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    color: c.mid,
    paddingBottom: 3,
    marginBottom: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: c.rule,
  },

  /* Generic item row */
  row: {
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    paddingVertical: 3,
    paddingHorizontal: 2,
    borderBottomWidth: 0.5,
    borderBottomColor: c.ruleLight,
  },
  rowLast: {
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    paddingVertical: 3,
    paddingHorizontal: 2,
  },
  rowUrgent: {
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    paddingVertical: 3.5,
    paddingHorizontal: 2,
    paddingLeft: 7,
    marginLeft: -3,
    borderLeftWidth: 3,
    borderLeftColor: c.urgentBar,
    backgroundColor: c.urgentBg,
    borderBottomWidth: 0.5,
    borderBottomColor: c.ruleLight,
  },

  /* Time column (schedule) */
  timeCol: {
    width: 82,
    fontSize: 8,
    fontWeight: 700,
    color: c.dark,
    paddingRight: 6,
    paddingTop: 0.5,
  },

  /* Checkbox */
  checkbox: {
    width: 10,
    height: 10,
    borderWidth: 1.2,
    borderColor: "#555",
    borderRadius: 1.5,
    marginRight: 6,
    marginTop: 1,
    flexShrink: 0,
  },

  /* Label + inline note */
  labelWrap: {
    flex: 1,
  },
  label: {
    fontSize: 9,
  },
  labelBold: {
    fontSize: 9,
    fontWeight: 700,
  },
  noteInline: {
    fontSize: 7.5,
    fontWeight: 300,
    color: c.note,
  },

  /* Body prose (fallback for body sections) */
  body: {
    marginTop: 4,
    padding: "5 8",
    backgroundColor: "#f8f8f6",
    borderLeftWidth: 2.5,
    borderLeftColor: c.ruleLight,
  },
  bodyLine: {
    fontSize: 8.5,
    color: "#444",
    lineHeight: 1.5,
    marginBottom: 1.5,
  },

  /* Footer */
  footer: {
    position: "absolute" as const,
    bottom: 28,
    left: 44,
    right: 44,
    flexDirection: "row" as const,
    justifyContent: "space-between" as const,
    borderTopWidth: 0.5,
    borderTopColor: c.ruleLight,
    paddingTop: 4,
  },
  footerText: {
    fontSize: 6.5,
    fontWeight: 300,
    color: c.faint,
  },
});

/* ------------------------------------------------------------------ */
/*  Components                                                         */
/* ------------------------------------------------------------------ */

function ItemRow({ item, isLast }: { item: BriefItem; isLast: boolean }) {
  const rowStyle = item.urgent
    ? styles.rowUrgent
    : isLast
      ? styles.rowLast
      : styles.row;

  const labelStyle =
    item.highlight || item.urgent ? styles.labelBold : styles.label;

  return (
    <View style={rowStyle}>
      {item.time && <Text style={styles.timeCol}>{item.time}</Text>}
      {item.checkbox && <View style={styles.checkbox} />}
      <Text style={styles.labelWrap}>
        <Text style={labelStyle}>{item.label}</Text>
        {item.note && (
          <Text style={styles.noteInline}>{" \u00B7 "}{item.note}</Text>
        )}
      </Text>
    </View>
  );
}

function Section({ section }: { section: BriefSection }) {
  return (
    <View style={styles.section} wrap={false}>
      <Text style={styles.sectionHeading}>{section.heading}</Text>

      {section.items?.map((item, i) => (
        <ItemRow
          key={i}
          item={item}
          isLast={i === (section.items?.length ?? 0) - 1}
        />
      ))}

      {section.body && (
        <View style={styles.body}>
          {section.body
            .split("\n")
            .filter(Boolean)
            .map((line, i) => (
              <Text key={i} style={styles.bodyLine}>
                {line}
              </Text>
            ))}
        </View>
      )}
    </View>
  );
}

function BriefDoc({ brief, generatedAt }: { brief: Brief; generatedAt: Date }) {
  const date = generatedAt.toISOString().slice(0, 10);
  const time = generatedAt.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header} fixed>
          <View>
            <Text style={styles.title}>{brief.title}</Text>
            {brief.subtitle && (
              <Text style={styles.subtitle}>{brief.subtitle}</Text>
            )}
          </View>
          <Text style={styles.headerMeta}>Generated {time}</Text>
        </View>

        {brief.sections.map((s, i) => (
          <Section key={i} section={s} />
        ))}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>callsheet</Text>
          <Text style={styles.footerText}>{date} {time}</Text>
        </View>
      </Page>
    </Document>
  );
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export async function renderPdf(
  brief: Brief,
  outputDir: string,
): Promise<string> {
  mkdirSync(outputDir, { recursive: true });
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const pdfPath = join(outputDir, `callsheet_${today}.pdf`);

  const buffer = await renderToBuffer(
    <BriefDoc brief={brief} generatedAt={now} />,
  );
  writeFileSync(pdfPath, buffer);

  return pdfPath;
}
