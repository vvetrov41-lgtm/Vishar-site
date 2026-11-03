-- Add video consultation booking-card support after approved migration review.
-- Video and in-person consultations use the same financial-free card shape.
alter table crm_private.booking_cards drop constraint booking_cards_financial_shape;
