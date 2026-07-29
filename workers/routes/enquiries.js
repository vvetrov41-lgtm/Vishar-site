// Durable enquiry intake.
//
// Success means one thing only: the enquiry row exists, every required file is
// in the private bucket, every manifest is marked ready, and intake is
// finalised. Nothing else counts — least of all a Telegram message.
//
// Ordering matters and is deliberate:
//
//   1. validate everything before touching a provider;
//   2. commit the enquiry and its pending file manifests in one transaction;
//   3. upload the objects;
//   4. mark each manifest ready;
//   5. finalise;
//   6. only then, notify.
//
// A failure at step 3 or 4 deletes what this attempt uploaded, records a safe
// failure code, and returns a retryable error. The same idempotency key resumes
// the original enquiry rather than creating a second one, and an unfinished
// intake stays out of the normal new-enquiry queue until it completes.

import {
  RequestError,
  ConfigurationError,
  assertRequestSize,
  isAllowedOriginFor,
  jsonResponse,
} from '../lib/http.js';
import { parseEnquiryFields, parseEnquiryFiles } from '../lib/validation.js';
import { createSupabaseClient, toRequestError } from '../lib/supabase.js';
import { createStorageClient } from '../lib/storage.js';
import { buildEnquiryNotification, sendNotification } from '../lib/telegram.js';

export async function handleEnquiryIntake(request, env, { cors, logger, fetchImpl = fetch }) {
  const startedAt = Date.now();

  try {
    // An absent or unrecognised Origin is refused outright. A CORS response
    // header only stops a browser from *reading* the reply; it does not stop
    // the request from being processed, and this route writes to a database.
    const origin = request.headers.get('Origin') || '';
    if (!isAllowedOriginFor(origin, env)) {
      logger.warn('enquiry.origin_rejected', { route: 'enquiries', errorCode: 'origin_not_allowed' });
      throw new RequestError('origin_not_allowed', 'This request could not be accepted.', 403);
    }

    assertRequestSize(request);

    let form;
    try {
      form = await request.formData();
    } catch {
      throw new RequestError('malformed_multipart', 'That submission could not be read. Please try again.');
    }

    const { honeypot, idempotencyKey, enquiry } = parseEnquiryFields(form);
    if (honeypot) {
      // Answer exactly as a success would, so a bot learns nothing, and record
      // nothing.
      logger.info('enquiry.honeypot', { route: 'enquiries', outcome: 'ignored' });
      return jsonResponse({ ok: true }, 200, cors);
    }

    const files = await parseEnquiryFiles(form);

    const supabase = createSupabaseClient(env, fetchImpl);
    const storage = createStorageClient(supabase, fetchImpl);

    logger.info('enquiry.validated', {
      route: 'enquiries',
      stage: 'validated',
      fileCount: files.length,
    });

    // ---- Commit the record first -------------------------------------------
    const intake = await supabase.rpc('create_enquiry_intake', {
      p_idempotency_key: idempotencyKey,
      p_client: {
        full_name: enquiry.name,
        email: enquiry.email,
        phone: enquiry.phone || null,
        instagram: enquiry.instagram || null,
        preferred_contact: enquiry.preferredReply,
        travelling_from: enquiry.travellingFrom || null,
      },
      p_enquiry: {
        project_type: enquiry.projectType,
        placement: enquiry.placement,
        approximate_size: enquiry.size,
        cover_up: enquiry.coverUp,
        preferred_timing: enquiry.timing || null,
        idea: enquiry.idea,
        source: enquiry.source,
        landing_page: enquiry.landingPage || null,
        referrer: enquiry.referrer || null,
        utm_source: enquiry.utmSource || null,
        utm_medium: enquiry.utmMedium || null,
        utm_campaign: enquiry.utmCampaign || null,
        utm_content: enquiry.utmContent || null,
        utm_term: enquiry.utmTerm || null,
      },
      p_files: files.map((file) => ({
        mime_type: file.mime_type,
        safe_extension: file.safe_extension,
        byte_size: file.byte_size,
        checksum: file.checksum,
        original_filename: file.original_filename,
      })),
    });

    const enquiryId = intake?.enquiry_id;
    const referenceNumber = intake?.reference_number;
    const manifests = Array.isArray(intake?.files) ? intake.files : [];

    if (!enquiryId || !referenceNumber) {
      throw new RequestError('intake_incomplete', 'We could not save your enquiry. Please try again.', 503);
    }

    logger.info('enquiry.persisted', {
      route: 'enquiries',
      stage: 'persisted',
      enquiryId,
      referenceNumber,
      replayed: Boolean(intake.replayed),
      intakeState: intake.intake_state,
      clientConflict: Boolean(intake.client_conflict),
      fileCount: manifests.length,
    });

    // A completed replay is finished business: return the original reference
    // without re-uploading anything.
    if (intake.replayed && intake.intake_state === 'complete') {
      logger.info('enquiry.replayed', {
        route: 'enquiries',
        enquiryId,
        referenceNumber,
        outcome: 'already_complete',
        durationMs: Date.now() - startedAt,
      });
      return jsonResponse({ ok: true, reference: referenceNumber, replayed: true }, 200, cors);
    }

    // ---- Upload the objects -------------------------------------------------
    const uploadedPaths = [];

    try {
      for (let index = 0; index < manifests.length; index += 1) {
        const manifest = manifests[index];
        const file = files[index];

        // A replay that already stored this object skips it. Re-uploading would
        // be harmless but pointless.
        if (manifest.upload_state === 'ready') {
          continue;
        }

        if (!file) {
          throw new RequestError('manifest_mismatch', 'We could not save your images. Please try again.', 503);
        }

        await storage.upload(manifest.storage_path, file.bytes, file.mime_type);
        uploadedPaths.push(manifest.storage_path);

        await supabase.rpc('mark_enquiry_file_uploaded', {
          p_file_id: manifest.file_id,
          p_checksum: file.checksum,
        });

        logger.info('enquiry.file_stored', {
          route: 'enquiries',
          enquiryId,
          fileId: manifest.file_id,
          fileIndex: index,
          byteSize: file.byte_size,
          mimeType: file.mime_type,
        });
      }

      await supabase.rpc('finalize_enquiry_intake', { p_enquiry_id: enquiryId });
    } catch (uploadError) {
      // Compensating cleanup, then a safe operational failure. The enquiry row
      // survives so the same idempotency key can resume it, and reconciliation
      // can find it, but it does not appear in the normal new-enquiry queue.
      let cleanedUp = 0;
      for (const path of uploadedPaths) {
        if (await storage.remove(path)) cleanedUp += 1;
      }

      const errorCode = uploadError?.code === 'storage_unavailable'
        ? 'storage_upload_failed'
        : 'intake_finalisation_failed';

      try {
        await supabase.rpc('fail_enquiry_intake', {
          p_enquiry_id: enquiryId,
          p_error_code: errorCode,
        });
      } catch {
        // Recording the failure is itself best-effort; the enquiry is already
        // outside the queue because intake never completed.
      }

      logger.error('enquiry.intake_failed', {
        route: 'enquiries',
        stage: 'storage',
        enquiryId,
        referenceNumber,
        errorCode,
        uploadedCount: uploadedPaths.length,
        cleanedUpCount: cleanedUp,
        durationMs: Date.now() - startedAt,
      });

      throw new RequestError(
        errorCode,
        'We saved your details but could not store your images. Please try sending the form again.',
        503
      );
    }

    // ---- Notify, after the point of no return -------------------------------
    // Everything below this line is best-effort. The enquiry is already durable
    // and the outbox row created during intake is the retry path, so nothing
    // here can turn a saved enquiry into a failed submission.
    const notification = await sendNotification(
      env,
      buildEnquiryNotification({
        referenceNumber,
        fileCount: manifests.length,
        clientConflict: Boolean(intake.client_conflict),
      }),
      fetchImpl
    );

    if (!notification.delivered) {
      logger.warn('enquiry.notification_failed', {
        route: 'enquiries',
        enquiryId,
        referenceNumber,
        errorCode: notification.errorCode,
        statusClass: notification.statusClass,
      });
    }

    logger.info('enquiry.completed', {
      route: 'enquiries',
      enquiryId,
      referenceNumber,
      fileCount: manifests.length,
      outcome: 'complete',
      durationMs: Date.now() - startedAt,
    });

    return jsonResponse({ ok: true, reference: referenceNumber }, 200, cors);
  } catch (error) {
    const safe = error instanceof RequestError || error instanceof ConfigurationError
      ? error
      : toRequestError(error);

    if (safe.status >= 500) {
      logger.error('enquiry.failed', {
        route: 'enquiries',
        errorCode: safe.code,
        status: safe.status,
        durationMs: Date.now() - startedAt,
      });
    } else {
      logger.info('enquiry.rejected', {
        route: 'enquiries',
        errorCode: safe.code,
        status: safe.status,
        durationMs: Date.now() - startedAt,
      });
    }

    return jsonResponse({ ok: false, error: safe.message, code: safe.code }, safe.status, cors);
  }
}
