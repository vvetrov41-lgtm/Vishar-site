// Durable enquiry intake.
//
// Success means one thing only: the enquiry row exists, every required file is
// in the private bucket, every manifest is marked ready, and intake is
// finalised. Nothing else counts — least of all a Telegram message.
//
// External and Vishar-hosted forms deliberately converge here after their
// transport-specific source resolution. The upload/finalise/outbox pipeline is
// shared so a hosted form cannot drift into a second booking stack.

import {
  RequestError,
  ConfigurationError,
  parseBoundedMultipartFormData,
  isAllowedOriginFor,
  isCanonicalHttpsOrigin,
  getCorsHeaders,
  jsonResponse,
} from '../lib/http.js';
import { parseEnquiryFields, parseEnquiryFiles } from '../lib/validation.js';
import { createSupabaseClient, SupabaseError, toRequestError } from '../lib/supabase.js';
import { createStorageClient } from '../lib/storage.js';
import { buildEnquiryNotification, sendNotification } from '../lib/telegram.js';
import {
  readBookingSourcePublicId,
  readTrustedBookingConfig,
  SUPPORTED_BOOKING_FORM_VERSION,
} from '../lib/provider-routing.js';

const SUPPORTED_HOSTED_FORM_TEMPLATE = 'tattoo-enquiry';

export async function handleEnquiryIntake(request, env, options) {
  return handleEnquiryIntakeInternal(request, env, { ...options, hostedSourceId: null });
}

export async function handleHostedEnquiryIntake(request, env, hostedSourceId, options) {
  return handleEnquiryIntakeInternal(request, env, { ...options, hostedSourceId });
}

async function handleEnquiryIntakeInternal(
  request,
  env,
  { cors = {}, logger, fetchImpl = fetch, hostedSourceId = null }
) {
  const startedAt = Date.now();
  const hostedMode = Boolean(hostedSourceId);
  let responseCors = cors;

  try {
    const origin = request.headers.get('Origin') || '';
    const publicSourceId = hostedMode ? null : readBookingSourcePublicId(request);
    let bookingConfig;
    let supabase = null;

    if (hostedMode) {
      // A hosted form is served by this same trusted Worker. It does not use an
      // external Origin as authority. The opaque URL id selects a source and
      // the database derives the Artist/source/template from that id.
      supabase = createSupabaseClient(env, fetchImpl);
      let resolved;
      try {
        const result = await supabase.rpc('resolve_hosted_booking_source', {
          p_public_source_id: hostedSourceId,
        });
        resolved = Array.isArray(result) ? result[0] : result;
      } catch (error) {
        if (
          error instanceof SupabaseError
          && error.status >= 400
          && error.status < 500
          && error.status !== 429
        ) {
          logger.info('enquiry.hosted_source_rejected', {
            route: 'enquiries',
            errorCode: 'booking_form_unavailable',
          });
          throw new RequestError(
            'booking_form_unavailable',
            'This booking form is not available.',
            404
          );
        }
        throw error;
      }

      if (!resolved?.source_key || !resolved?.form_version || !resolved?.form_template) {
        throw new RequestError('booking_form_unavailable', 'This booking form is not available.', 404);
      }
      if (
        resolved.form_version !== SUPPORTED_BOOKING_FORM_VERSION
        || resolved.form_template !== SUPPORTED_HOSTED_FORM_TEMPLATE
      ) {
        throw new ConfigurationError(
          'booking_form_version_unsupported',
          'This booking form needs to be updated before it can accept enquiries.'
        );
      }
      bookingConfig = {
        publicSourceId: hostedSourceId,
        sourceKey: resolved.source_key,
        formVersion: resolved.form_version,
        formTemplate: resolved.form_template,
      };
    } else if (publicSourceId) {
      // CORS reflection is only browser plumbing. This RPC is the authority:
      // it requires the opaque public id AND the exact observed HTTPS Origin.
      responseCors = getCorsHeaders(origin, env, request);
      if (!isCanonicalHttpsOrigin(origin)) {
        logger.warn('enquiry.origin_rejected', { route: 'enquiries', errorCode: 'origin_not_allowed' });
        throw new RequestError('origin_not_allowed', 'This request could not be accepted.', 403);
      }

      supabase = createSupabaseClient(env, fetchImpl);
      let resolved;
      try {
        const result = await supabase.rpc('resolve_booking_source_public', {
          p_public_source_id: publicSourceId,
          p_origin: origin,
        });
        resolved = Array.isArray(result) ? result[0] : result;
      } catch (error) {
        if (
          error instanceof SupabaseError
          && error.status >= 400
          && error.status < 500
          && error.status !== 429
        ) {
          logger.warn('enquiry.origin_rejected', { route: 'enquiries', errorCode: 'origin_not_allowed' });
          throw new RequestError('origin_not_allowed', 'This request could not be accepted.', 403);
        }
        throw error;
      }

      if (!resolved?.source_key || !resolved?.form_version) {
        throw new RequestError('origin_not_allowed', 'This request could not be accepted.', 403);
      }
      if (resolved.form_version !== SUPPORTED_BOOKING_FORM_VERSION) {
        throw new ConfigurationError(
          'booking_form_version_unsupported',
          'This booking form needs to be updated before it can accept enquiries.'
        );
      }
      bookingConfig = {
        sourceKey: resolved.source_key,
        formVersion: resolved.form_version,
      };
    } else {
      // Rollout fallback for the two already-deployed website Workers. This path
      // can be removed only after every live form carries a registry source id.
      if (!isAllowedOriginFor(origin, env)) {
        logger.warn('enquiry.origin_rejected', { route: 'enquiries', errorCode: 'origin_not_allowed' });
        throw new RequestError('origin_not_allowed', 'This request could not be accepted.', 403);
      }
      bookingConfig = readTrustedBookingConfig(env);
    }

    let form;
    try {
      form = await parseBoundedMultipartFormData(request);
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError('malformed_multipart', 'That submission could not be read. Please try again.');
    }

    const { honeypot, idempotencyKey, enquiry } = parseEnquiryFields(form);
    if (honeypot) {
      // Answer exactly as a success would, so a bot learns nothing, and record
      // nothing. Source resolution may already have performed a read-only
      // lookup; it never writes a client or enquiry for a honeypot hit.
      logger.info('enquiry.honeypot', { route: 'enquiries', outcome: 'ignored' });
      return jsonResponse({ ok: true }, 200, responseCors);
    }

    const files = await parseEnquiryFiles(form);

    if (!supabase) supabase = createSupabaseClient(env, fetchImpl);
    const storage = createStorageClient(supabase, fetchImpl);

    logger.info('enquiry.validated', {
      route: 'enquiries',
      stage: 'validated',
      sourceMode: hostedMode ? 'hosted' : 'external',
      fileCount: files.length,
    });

    const commonIntakeArgs = {
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
        discovery_source: enquiry.discoverySource || null,
        discovery_source_detail: enquiry.discoverySourceDetail || null,
        source: enquiry.source,
        landing_page: enquiry.landingPage || null,
        referrer: enquiry.referrer || null,
        utm_source: enquiry.utmSource || null,
        utm_medium: enquiry.utmMedium || null,
        utm_campaign: enquiry.utmCampaign || null,
        utm_content: enquiry.utmContent || null,
        utm_term: enquiry.utmTerm || null,
        privacy_acknowledged: enquiry.privacyAcknowledged,
        privacy_notice_version: enquiry.privacyNoticeVersion,
      },
      p_files: files.map((file) => ({
        mime_type: file.mime_type,
        safe_extension: file.safe_extension,
        byte_size: file.byte_size,
        checksum: file.checksum,
        original_filename: file.original_filename,
      })),
    };

    // Both paths resolve their source again inside the persistence transaction.
    // This closes the window where an operator deactivates a source after the
    // read-only page/request lookup but before the enquiry commits.
    const intake = hostedMode
      ? await supabase.rpc('create_hosted_enquiry_intake', {
          p_public_source_id: bookingConfig.publicSourceId,
          ...commonIntakeArgs,
        })
      : await supabase.rpc('create_trusted_enquiry_intake', {
          p_source_key: bookingConfig.sourceKey,
          p_origin: origin,
          p_form_version: bookingConfig.formVersion,
          ...commonIntakeArgs,
        });

    const enquiryId = intake?.enquiry_id;
    const referenceNumber = intake?.reference_number;
    const manifests = Array.isArray(intake?.files) ? intake.files : [];

    if (!enquiryId || !referenceNumber) {
      throw new RequestError('intake_incomplete', 'We could not save your enquiry. Please try again.', 503);
    }

    if (
      manifests.length !== files.length ||
      manifests.some((manifest, index) => (
        Number(manifest?.ordinal) !== index ||
        manifest?.mime_type !== files[index]?.mime_type ||
        manifest?.safe_extension !== files[index]?.safe_extension ||
        Number(manifest?.byte_size) !== files[index]?.byte_size ||
        manifest?.checksum !== files[index]?.checksum
      ))
    ) {
      throw new RequestError('manifest_mismatch', 'We could not save your images. Please try again.', 503);
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

    if (intake.replayed && intake.intake_state === 'complete') {
      logger.info('enquiry.replayed', {
        route: 'enquiries',
        enquiryId,
        referenceNumber,
        outcome: 'already_complete',
        durationMs: Date.now() - startedAt,
      });
      return jsonResponse({ ok: true, reference: referenceNumber, replayed: true }, 200, responseCors);
    }

    const cleanupPaths = new Set();
    let finalization;

    try {
      for (let index = 0; index < manifests.length; index += 1) {
        const manifest = manifests[index];
        const file = files[index];

        if (manifest.upload_state === 'ready') continue;
        if (!file) {
          throw new RequestError('manifest_mismatch', 'We could not save your images. Please try again.', 503);
        }

        await storage.upload(manifest.storage_path, file.bytes, file.mime_type);

        try {
          await supabase.rpc('mark_enquiry_file_uploaded', {
            p_file_id: manifest.file_id,
            p_checksum: file.checksum,
          });
        } catch (markError) {
          if (
            markError instanceof SupabaseError
            && markError.status >= 400
            && markError.status < 500
            && markError.status !== 429
          ) {
            cleanupPaths.add(manifest.storage_path);
          }
          throw markError;
        }

        logger.info('enquiry.file_stored', {
          route: 'enquiries',
          enquiryId,
          fileId: manifest.file_id,
          fileIndex: index,
          byteSize: file.byte_size,
          mimeType: file.mime_type,
        });
      }

      finalization = await supabase.rpc('finalize_enquiry_intake', { p_enquiry_id: enquiryId });
    } catch (uploadError) {
      let cleanedUp = 0;
      for (const path of cleanupPaths) {
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
        // Best effort only; the incomplete enquiry remains outside normal queue.
      }

      logger.error('enquiry.intake_failed', {
        route: 'enquiries',
        stage: 'storage',
        enquiryId,
        referenceNumber,
        errorCode,
        uncommittedUploadCount: cleanupPaths.size,
        cleanedUpCount: cleanedUp,
        durationMs: Date.now() - startedAt,
      });

      throw new RequestError(
        errorCode,
        'We saved your details but could not store your images. Please try sending the form again.',
        503
      );
    }

    const outboxId = finalization?.outbox_id;
    let notification = { delivered: false, errorCode: 'outbox_route_missing' };
    if (outboxId) {
      try {
        const resolved = await supabase.rpc('resolve_outbox_route', { p_outbox_id: outboxId });
        const route = Array.isArray(resolved) ? resolved[0] : resolved;
        notification = route
          ? await sendNotification(env, route, buildEnquiryNotification({
              referenceNumber,
              fileCount: manifests.length,
              clientConflict: Boolean(intake.client_conflict),
            }), fetchImpl)
          : { delivered: false, errorCode: 'provider_route_unavailable' };
      } catch {
        notification = { delivered: false, errorCode: 'provider_route_unavailable' };
      }

      try {
        await supabase.rpc('record_outbox_attempt', {
          p_outbox_id: outboxId,
          p_succeeded: notification.delivered,
          p_error_code: notification.delivered ? null : notification.errorCode,
        });
      } catch {
        logger.warn('enquiry.notification_outcome_unrecorded', {
          route: 'enquiries',
          enquiryId,
          referenceNumber,
          outboxId,
        });
      }
    }

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

    return jsonResponse({ ok: true, reference: referenceNumber }, 200, responseCors);
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

    return jsonResponse({ ok: false, error: safe.message, code: safe.code }, safe.status, responseCors);
  }
}