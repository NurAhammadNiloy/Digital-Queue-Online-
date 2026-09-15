export type Assignment = { locationId: string; serviceId: string };
export type StaffView = {
  id: string;
  name: string;
  staffCode: string;
  active: boolean;
  archived: boolean;
  createdAt: string;
  assignments: Assignment[];
};
export type StaffOptions = {
  locations: { id: string; name: string; active: boolean }[];
  services: { id: string; locationId: string; name: string; active: boolean }[];
};
