import prisma from "@/lib/prisma";
import { logger, retry, task } from "@trigger.dev/sdk/v3";
// @ts-ignore
import mupdf from "mupdf";
import { putFileServer } from "../files/put-file-server";
import { getFile } from "../files/get-file";

export const convertPage = task({
  id: "convert-page",
  run: async (
    payload: {
      documentVersionId: string;
      pageNumber: number;
      url: string;
      teamId: string;
    },
    { ctx },
  ) => {
    const { documentVersionId, pageNumber, url, teamId } = payload;

    const existingPage = await prisma.documentPage.findUnique({
      where: {
        pageNumber_versionId: {
          pageNumber: pageNumber,
          versionId: documentVersionId,
        },
      },
    });

    if (existingPage) {
      logger.info("Page already exists", { payload });

      return {
        documentPageId: existingPage.id,
      };
    }

    const response = await retry.fetch(url, {
      retry: {
        "5xx": {
          strategy: "backoff",
          maxAttempts: 5,
          minTimeoutInMs: 1000,
          maxTimeoutInMs: 10000,
          factor: 2,
          randomize: true,
        },
      },
    });

    if (!response.ok) {
      logger.error("Failed to fetch PDF in conversion process", {
        responseHeaders: Object.fromEntries(response.headers),
        status: response.status,
        payload,
      });

      throw new Error("Failed to fetch PDF");
    }

    const pdfData = await response.arrayBuffer();
    const doc = mupdf.Document.openDocument(pdfData, "application/pdf");

    const doc_to_screen = mupdf.Matrix.scale(216 / 72, 216 / 72); // scale 3x // to 216 DPI
    let page = doc.loadPage(pageNumber - 1); // 0-based page index

    // get links
    const links = page.getLinks();
    const embeddedLinks = links.map((link: any) => link.getURI());

    let pixmap = page.toPixmap(
      // [3, 0, 0, 3, 0, 0], // scale 3x // to 300 DPI
      doc_to_screen,
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    );

    const pngBuffer = pixmap.asPNG(); // as PNG

    let buffer = Buffer.from(pngBuffer, "binary");

    // get docId from url with starts with "doc_" with regex
    const match = url.match(/(doc_[^\/]+)\//);
    const docId = match ? match[1] : undefined;

    const { type, data } = await putFileServer({
      file: {
        name: `page-${pageNumber}.png`,
        type: "image/png",
        buffer,
      },
      teamId,
      docId,
    });

    buffer = Buffer.alloc(0); // free memory
    pixmap.destroy(); // free memory
    page.destroy(); // free memory
    doc.destroy(); // free memory

    if (!data || !type) {
      throw new Error(`Failed to upload document page ${pageNumber}`);
    }

    const documentPage = await prisma.documentPage.create({
      data: {
        versionId: documentVersionId,
        pageNumber: pageNumber,
        file: data,
        storageType: type,
        embeddedLinks: embeddedLinks,
      },
    });

    return { documentPageId: documentPage.id };
  },
});

export const convertPDFToImages = task({
  id: "convert-pdf-to-images",
  run: async (
    payload: {
      documentVersionId: string;
    },
    { ctx },
  ) => {
    const { documentVersionId } = payload;

    logger.info("Converting PDF to images", { payload });

    const documentVersion = await prisma.documentVersion.findUnique({
      where: {
        id: documentVersionId,
      },
      include: {
        document: {
          include: {
            team: true,
          },
        },
      },
    });

    if (!documentVersion) {
      logger.error("File not found");
      return;
    }

    const { team } = documentVersion.document;

    if (!team) {
      logger.error("Team not found");
      return;
    }

    let numPages = documentVersion.numPages;

    if (!numPages) {
      logger.error("Number of pages not found in document version");
      return;
    }

    logger.info("Number of pages in PDF", { numPages });

    const signedUrl = await getFile({
      type: documentVersion.storageType,
      data: documentVersion.file,
    });

    // Create an array of all the page numbers
    const pageNumbers: number[] = [];

    for (let i = 1; i <= numPages; i++) {
      pageNumbers.push(i);
    }

    const results = await convertPage.batchTriggerAndWait({
      items: pageNumbers.map((pageNumber) => ({
        payload: {
          documentVersionId,
          pageNumber,
          url: signedUrl,
          teamId: team.id,
        },
      })),
    });

    if (results.runs.some((run) => !run.ok)) {
      throw new Error(`Failed to convert PDF to images`);
    }

    await logger.trace("update-document-version", async (span) => {
      await prisma.$transaction([
        prisma.documentVersion.update({
          where: {
            id: documentVersionId,
          },
          data: {
            hasPages: true,
            isPrimary: true,
          },
        }),
        prisma.documentVersion.updateMany({
          where: {
            documentId: documentVersion.documentId,
            versionNumber: {
              not: documentVersion.versionNumber,
            },
          },
          data: {
            isPrimary: false,
          },
        }),
      ]);
    });

    await retry.fetch(
      `${process.env.NEXTAUTH_URL}/api/revalidate?secret=${process.env.REVALIDATE_TOKEN}&documentId=${documentVersion.documentId}`,
    );

    return {
      success: true,
      message: "Successfully converted PDF to images",
    };
  },
});
