# Changelog

## 0.5.0

Initial public release.

- Messaging: `send_sms`, `send_mms`, `send_whatsapp`, `get_message`
- Reporting: `list_messages` (delivery status + inbound replies, with filters)
- Webhooks: `create_webhook`, `list_webhooks`, `delete_webhook`
- Contacts & lists: `create_list`, `get_lists`, `get_list`, `add_contact_to_list`, `remove_contact_from_list`, `delete_list`
- Account: `get_balance`
- API discovery (live specs): `list_specs`, `list_endpoints`, `search_endpoints`, `get_endpoint`
- Dual authentication: `x-api-key` for messaging/webhooks, HTTP Basic for contacts/balance
