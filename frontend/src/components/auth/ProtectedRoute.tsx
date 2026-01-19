import React from 'react';
import { Navigate, useLocation, Outlet } from 'react-router-dom';
import { useAuth } from '../../context/AuthProvider';

interface ProtectedRoutesProps {
    allowedRoles?: string[];
}

export const ProtectedRoutes = ({ allowedRoles }: ProtectedRoutesProps) => {
    const { user } = useAuth();
    const location = useLocation();

    const storedUserString = localStorage.getItem('user_data');
    const currentUser = user || (storedUserString ? JSON.parse(storedUserString) : null);
    let token = currentUser?.token || localStorage.getItem('token');
    if (token === "null" || token === "undefined") {
        token = null;
    }

    if (!currentUser || !token) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    if (allowedRoles && !allowedRoles.includes(currentUser.role)) {
        console.log(`PROTECTED ROUTE DEBUG: Access denied. Role mismatch. Required: ${allowedRoles}, Current: ${currentUser.role}`);
        return <Navigate to="/search" replace />;
    }

    return <Outlet />;
};