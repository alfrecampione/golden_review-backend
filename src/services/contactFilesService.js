import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { pool } from '../lib/dbPool.js';
import { uploadToS3 } from './uploadToS3.js';
import { determineApplication } from './determine_application.js';
import { getQqToken } from './qqAuth.js';

const BASE_URL = (process.env.DB_BASE_URL || 'https://api.qqcatalyst.com').replace(/\/+$/, '');
const PAGE_SIZE = Number(process.env.DB_PAGE_SIZE || 100);
const TABLE = process.env.DB_FILES_TABLE || 'qq.contact_files';
// El token se obtiene dinámicamente vía OAuth en qqAuth.js

async function getApi() {
    const token = await getQqToken();
    return axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}` },
        timeout: 60000
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(fn, { retries = 4, baseDelayMs = 600 } = {}) {
    let i = 0;
    while (true) {
        try {
            return await fn();
        } catch (err) {
            const st = err?.response?.status;
            const retriable = st === 429 || (st >= 500 && st <= 599);
            if (!retriable || i >= retries) throw err;
            await sleep(baseDelayMs * 2 ** i++);
        }
    }
}

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function sanitizeName(value) {
    return String(value ?? '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
}

function inferExt(ct) {
    const map = {
        'application/pdf': '.pdf',
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'application/vnd.ms-excel': '.xls',
        'text/plain': '.txt'
    };
    return map[ct?.toLowerCase()] || '';
}

function looksLikeTextOrHtml(buf) {
    const head = buf.slice(0, 200).toString('utf8').toLowerCase();
    return head.startsWith('{') || head.includes('<!doctype') || head.includes('<html');
}

function dedupePath(p) {
    if (!fs.existsSync(p)) return p;
    const dir = path.dirname(p);
    const ext = path.extname(p);
    const base = path.basename(p, ext);
    let i = 1;
    let candidate;
    do {
        candidate = path.join(dir, `${base}-${i++}${ext}`);
    } while (fs.existsSync(candidate));
    return candidate;
}

const getFileId = (it) => it?.Id ?? it?.FileId ?? it?.id ?? it?.DocumentId ?? null;

async function listPage(contactId, pageNumber, pageSize) {
    const api = await getApi();
    const res = await api.get('/v1/Files/FilesByContact', {
        params: { contactid: contactId, dlFileType: 'None', pageNumber, pageSize },
        validateStatus: () => true
    });

    if (res.status === 401 && typeof res.data === 'string' && res.data.includes('Maximum admitted 60 requests per Minute')) {
        await sleep(65000);
        return await listPage(contactId, pageNumber, pageSize);
    }

    if (res.status < 200 || res.status >= 300) {
        // Log QQ API error details for debugging
        console.error('QQ API error:', {
            status: res.status,
            data: res.data,
            contactId,
            pageNumber,
            pageSize
        });
        throw new Error(`HTTP ${res.status} en FilesByContact: ${JSON.stringify(res.data)}`);
    }

    return res.data;
}

async function listAllUnique(contactId) {
    const seen = new Set();
    const all = [];
    let page = 1;
    let pagesTotal = null;
    while (true) {
        const listing = await listPage(contactId, page, PAGE_SIZE);
        const items = Array.isArray(listing?.Data) ? listing.Data : [];
        if (pagesTotal == null && Number.isFinite(listing?.PagesTotal)) pagesTotal = listing.PagesTotal;

        let newInPage = 0;
        for (const it of items) {
            const fid = getFileId(it);
            if (!fid || seen.has(fid)) continue;
            seen.add(fid);
            all.push(it);
            newInPage++;
        }
        const noMore = items.length < PAGE_SIZE || page >= pagesTotal || newInPage === 0;
        if (noMore) break;
        page++;
    }
    return all;
}

async function getRaw(fileId) {
    const api = await getApi();
    return withRetry(() =>
        api.get(`/v1/Files/${fileId}`, {
            headers: { Accept: 'application/octet-stream, application/json;q=0.9, */*;q=0.8' },
            responseType: 'arraybuffer',
            validateStatus: () => true
        })
    );
}

async function getProps(fileId) {
    const api = await getApi();
    return withRetry(() =>
        api.get(`/v1/Files/Properties/${fileId}`, {
            headers: { Accept: 'application/json' },
            params: { downloadAs: 'Original' },
            validateStatus: () => true
        })
    );
}

const UPSERT_SQL = `
INSERT INTO ${TABLE} (
  file_id, contact_id, file_name_reported, content_type_reported, size_reported,
  created_on, modified_on, category, description, tags,
  download_mode, s3_url, content_type_final, size_final_bytes, content_disposition,
  is_insurance_id_card, insurance_number, insurance_carrier, insurance_effective, insurance_expiration,
  inserted_at, updated_at
) VALUES (
  $1,$2,$3,$4,$5,
  $6,$7,$8,$9,$10::jsonb,
  $11,$12,$13,$14,$15,
  $16,$17,$18,$19,$20,
  now(), now()
)
ON CONFLICT (file_id) DO UPDATE SET
  contact_id            = EXCLUDED.contact_id,
  file_name_reported    = EXCLUDED.file_name_reported,
  content_type_reported = EXCLUDED.content_type_reported,
  size_reported         = EXCLUDED.size_reported,
  created_on            = EXCLUDED.created_on,
  modified_on           = EXCLUDED.modified_on,
  category              = EXCLUDED.category,
  description           = EXCLUDED.description,
  tags                  = EXCLUDED.tags,
  download_mode         = EXCLUDED.download_mode,
  s3_url                = EXCLUDED.s3_url,
  content_type_final    = EXCLUDED.content_type_final,
  size_final_bytes      = EXCLUDED.size_final_bytes,
  content_disposition   = EXCLUDED.content_disposition,
  is_insurance_id_card  = EXCLUDED.is_insurance_id_card,
  insurance_number      = EXCLUDED.insurance_number,
  insurance_carrier     = EXCLUDED.insurance_carrier,
  insurance_effective   = EXCLUDED.insurance_effective,
  insurance_expiration  = EXCLUDED.insurance_expiration,
  updated_at            = now();
`;

export async function downloadFilesToDB(contactId) {
    if (!contactId) throw new Error('Debes pasar un contactId como argumento');

    const client = await pool.connect();
    const absOutDir = path.resolve(`./downloads/${contactId}`);
    ensureDir(absOutDir);

    const docs = await listAllUnique(contactId);
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    const filteredDocs = docs.filter((f) => {
        const createdRaw = f?.CreatedOn ?? f?.CreatedDate ?? f?.ModifiedOn;
        if (!createdRaw) return false;
        const created = new Date(createdRaw);
        return created > cutoff;
    });

    const existing = await client.query(`SELECT file_id FROM ${TABLE} WHERE contact_id = $1`, [contactId]);
    const existingIds = new Set(existing.rows.map((row) => String(row.file_id)));
    const newDocs = filteredDocs.filter((f) => !existingIds.has(String(getFileId(f))));

    if (newDocs.length === 0) {
        client.release();
        return {
            contactId,
            totalDocs: docs.length,
            filteredDocs: filteredDocs.length,
            newDocs: 0,
            uploaded: 0
        };
    }

    let uploaded = 0;
    let foundApplication = null;


    try {
        await client.query('BEGIN');

        for (const f of newDocs) {
            const fileId = getFileId(f);
            let baseName = sanitizeName(f?.FileName || `file_${fileId}`);

            const baseMeta = {
                file_id: String(fileId),
                contact_id: Number(contactId),
                file_name_reported: f?.FileName ?? null,
                content_type_reported: f?.ContentType ?? null,
                size_reported: f?.FileSize ?? f?.Length ?? null,
                created_on: f?.CreatedOn ?? f?.CreatedDate ?? null,
                modified_on: f?.ModifiedOn ?? f?.UpdatedDate ?? null,
                category: f?.Category ?? null,
                description: f?.Description ?? null,
                tags: f?.Tags ?? null,
                download_mode: null,
                s3_url: null,
                content_type_final: null,
                size_final_bytes: null,
                content_disposition: null,
                is_insurance_id_card: false,
                insurance_number: null,
                insurance_carrier: null,
                insurance_effective: null,
                insurance_expiration: null
            };

            try {
                const raw = await getRaw(fileId);

                if (raw.status >= 200 && raw.status < 300 && raw.data) {
                    const buf = Buffer.from(raw.data);
                    if (!looksLikeTextOrHtml(buf)) {
                        const ctHdr = raw.headers?.['content-type'] ?? null;
                        let finalName = baseName;
                        if (!path.extname(finalName)) {
                            const ext = inferExt(ctHdr);
                            if (ext) finalName += ext;
                        }

                        finalName = sanitizeName(finalName);
                        const absPath = dedupePath(path.join(absOutDir, finalName));
                        ensureDir(path.dirname(absPath));
                        fs.writeFileSync(absPath, buf);

                        let s3Url = null;
                        try {
                            s3Url = await uploadToS3(absPath, contactId, fileId);
                            fs.unlinkSync(absPath);
                            uploaded++;
                        } catch (s3Err) {
                            console.error(`Error subiendo a S3: ${s3Err.message}`);
                        }

                        await client.query(UPSERT_SQL, [
                            baseMeta.file_id,
                            baseMeta.contact_id,
                            baseMeta.file_name_reported,
                            baseMeta.content_type_reported,
                            baseMeta.size_reported,
                            baseMeta.created_on,
                            baseMeta.modified_on,
                            baseMeta.category,
                            baseMeta.description,
                            baseMeta.tags ? JSON.stringify(baseMeta.tags) : null,
                            'raw',
                            s3Url,
                            ctHdr,
                            buf.length,
                            raw.headers?.['content-disposition'] ?? null,
                            baseMeta.is_insurance_id_card ?? false,
                            baseMeta.insurance_number ?? null,
                            baseMeta.insurance_carrier ?? null,
                            baseMeta.insurance_effective ?? null,
                            baseMeta.insurance_expiration ?? null
                        ]);

                        // Detectar Application Form en PDFs subidos a S3
                        if (
                            ctHdr && ctHdr.toLowerCase().includes('pdf') &&
                            !foundApplication
                        ) {
                            // Buscar en S3 el PDF con Application Form
                            try {
                                const appResult = await determineApplication(contactId);
                                if (appResult && appResult.found) {
                                    foundApplication = {
                                        fileKey: appResult.fileKey,
                                        s3Url: appResult.s3Url
                                    };
                                }
                            } catch (appErr) {
                                console.error('Error detectando Application Form:', appErr.message);
                            }
                        }

                        continue;
                    }
                }

                const prop = await getProps(fileId);
                const d = prop.data || {};
                const b64 = d.File || d.file || d.FileBytesBase64 || d.FileByteArrayBase64;
                if (!b64) throw new Error('Sin contenido base64');
                const ct = d.ContentType || d.contentType || baseMeta.content_type_reported || null;
                const buf = Buffer.from(b64, 'base64');

                let finalName = sanitizeName(d.FileName || d.filename || baseName);
                if (!path.extname(finalName)) {
                    const ext = inferExt(ct);
                    if (ext) finalName += ext;
                }
                finalName = sanitizeName(finalName);
                const absPath = dedupePath(path.join(absOutDir, finalName));
                ensureDir(path.dirname(absPath));
                fs.writeFileSync(absPath, buf);

                let s3Url = null;
                try {
                    s3Url = await uploadToS3(absPath, contactId, fileId);
                    fs.unlinkSync(absPath);
                    uploaded++;
                } catch (s3Err) {
                    console.error(`Error subiendo a S3: ${s3Err.message}`);
                }

                await client.query(UPSERT_SQL, [
                    baseMeta.file_id,
                    baseMeta.contact_id,
                    baseMeta.file_name_reported,
                    baseMeta.content_type_reported,
                    baseMeta.size_reported,
                    baseMeta.created_on,
                    baseMeta.modified_on,
                    baseMeta.category,
                    baseMeta.description,
                    baseMeta.tags ? JSON.stringify(baseMeta.tags) : null,
                    'properties',
                    s3Url,
                    ct,
                    buf.length,
                    null,
                    baseMeta.is_insurance_id_card ?? false,
                    baseMeta.insurance_number ?? null,
                    baseMeta.insurance_carrier ?? null,
                    baseMeta.insurance_effective ?? null,
                    baseMeta.insurance_expiration ?? null
                ]);
            } catch (err) {
                console.error(`Error con ${baseName} (ID ${fileId}): ${err.message}`);
            }
        }

        try {
            fs.rmSync(absOutDir, { recursive: true, force: true });
        } catch (cleanErr) {
            console.warn(`No se pudo limpiar el directorio: ${cleanErr.message}`);
        }

        await client.query('COMMIT');
        return {
            contactId,
            totalDocs: docs.length,
            filteredDocs: filteredDocs.length,
            newDocs: newDocs.length,
            uploaded,
            applications: foundApplication ? [foundApplication] : []
        };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}
